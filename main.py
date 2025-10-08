import os
import time
import json
import hashlib
import hmac
import urllib.parse
from datetime import datetime, timedelta
from firebase_admin import initialize_app, firestore, auth
from firebase_admin.exceptions import FirebaseError
from google.cloud import functions
from concurrent.futures import TimeoutError

# Initialize Firebase Admin SDK
# The SDK automatically uses environment credentials when deployed to Cloud Functions
try:
    initialize_app()
except ValueError as e:
    # This might happen if initialize_app() is called multiple times in a local testing environment
    # In production, it only runs once per function instance
    print(f"Firebase already initialized or error: {e}")

db = firestore.client()
# NOTE: Replace 'default-footy-iq-app-id' with the __app_id used in your React frontend
APP_ID = os.environ.get('APP_ID', 'default-footy-iq-app-id')
# NOTE: Set this environment variable during deployment (your Telegram user ID/Firebase UID)
ADMIN_USER_ID = os.environ.get('ADMIN_USER_ID')
# NEW: You MUST set this environment variable for the auth bridge to work!
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')


# --- Utility Functions ---

def get_user_id_from_token(req):
    """Securely verifies and extracts the user ID from the Firebase ID Token."""
    auth_header = req.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    
    id_token = auth_header.split('Bearer ')[1]
    
    try:
        # Verify the ID token using the Firebase Admin SDK
        decoded_token = auth.verify_id_token(id_token)
        return decoded_token['uid']
    except Exception as e:
        print(f"Token verification failed: {e}")
        return None

def json_response(data, status=200):
    """Helper to return JSON responses with correct CORS headers."""
    # Cloud Functions automatically handles OPTIONS/preflight requests,
    # but we manually set CORS for simplicity
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    }
    return functions.http.Response(
        json.dumps(data),
        status=status,
        headers=headers
    )

def verify_telegram_data(init_data: str) -> dict | None:
    """
    Cryptographically verifies the Telegram WebApp initData hash using the Bot Token.
    Returns the verified data dictionary if successful, or None if validation fails.
    """
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN not set in environment variables.")
        return None
    
    # 1. Separate hash from other parameters
    parsed_data = urllib.parse.parse_qs(init_data)
    
    # Ensure 'hash' is present and extract it.
    if 'hash' not in parsed_data:
        return None
        
    hash_value = parsed_data.pop('hash')[0]

    # 2. Sort and concatenate parameters (excluding hash)
    # Re-encode for comparison, ensuring key=value format for all pairs
    check_string = '&'.join([
        f'{key}={value[0]}' 
        for key, value in sorted(parsed_data.items())
    ])

    # 3. Calculate Secret Key
    secret_key = hmac.new(
        key=b"WebAppData",
        msg=TELEGRAM_BOT_TOKEN.encode(),
        digestmod=hashlib.sha256
    ).digest()

    # 4. Calculate HMAC
    calculated_hash = hmac.new(
        key=secret_key,
        msg=check_string.encode(),
        digestmod=hashlib.sha256
    ).hexdigest()

    # 5. Compare and Validate
    if calculated_hash != hash_value:
        print(f"Telegram hash validation failed. Calculated: {calculated_hash}, Received: {hash_value}")
        return None
        
    # Validation successful. Extract user data.
    if 'user' in parsed_data:
        user_data = json.loads(parsed_data['user'][0])
        return user_data
        
    return None

# --- 0. TELEGRAM AUTH BRIDGE FUNCTION (NEW AND CRITICAL) ---
# Endpoint: POST /auth/telegram

def telegram_auth_bridge(req):
    """
    Secures the Telegram Mini App by verifying initData and minting a Firebase Custom Token.
    This function should be called ONLY by the frontend upon first launch/sign-in.
    """
    if req.method == 'OPTIONS':
        return json_response('', status=204)

    try:
        data = req.get_json(silent=True)
        init_data = data.get('initData')
        
        if not init_data:
            return json_response({'error': 'Missing initData in payload.'}, status=400)

        # Step 1: Verify the Telegram Data
        telegram_user = verify_telegram_data(init_data)

        if not telegram_user:
            return json_response({'error': 'Invalid or expired Telegram initiation data.'}, status=401)

        # Step 2: Extract Telegram User ID (UID for Firebase)
        telegram_uid = str(telegram_user['id'])
        
        # Step 3: Mint the Firebase Custom Token
        # Use the Telegram User ID as the Firebase UID for consistency
        custom_token = auth.create_custom_token(telegram_uid, {
            'telegram_id': telegram_uid,
            'username': telegram_user.get('username'),
            'first_name': telegram_user.get('first_name')
        })

        # Step 4: Ensure User Profile Exists (Optional, but good practice)
        # Create a user in Firebase Auth if they don't exist (handled implicitly by sign-in)
        # We also ensure a basic Firestore profile exists.
        
        user_profile_ref = db.document(f'artifacts/{APP_ID}/users/{telegram_uid}/gameData/profile')
        user_profile_ref.set({
            'telegram_id': telegram_uid,
            'name': telegram_user.get('first_name', 'Player') + (f" ({telegram_user.get('username')})" if telegram_user.get('username') else ""),
            'score': 0,
            'last_login': firestore.SERVER_TIMESTAMP
        }, merge=True)

        return json_response({'customToken': custom_token.decode('utf-8')})

    except Exception as e:
        print(f"Error in Telegram Auth Bridge: {e}")
        return json_response({'error': 'Internal authentication error.'}, status=500)

# --- 1. ADMIN QUIZ UPLOAD FUNCTION ---
# Endpoint: POST /admin/upload_quiz

def admin_upload_quiz(req):
# ... (function body remains the same) ...
    """
    Secured function to upload a new quiz to Firestore. 
    Requires valid Firebase ID Token and matching ADMIN_USER_ID.
    """
    if req.method == 'OPTIONS':
        return json_response('', status=204) # Handle preflight

    try:
        # Step 1: Authentication and Authorization Check
        user_id = get_user_id_from_token(req)
        if not user_id:
            return json_response({'error': 'Unauthorized: Missing or invalid token.'}, status=401)
            
        if user_id != ADMIN_USER_ID:
            print(f"Unauthorized admin attempt by user: {user_id}")
            return json_response({'error': 'Forbidden: User is not the designated admin.'}, status=403)

        # Step 2: Parse and Validate Data
        data = req.get_json(silent=True)
        if not data or 'quizId' not in data or 'questions' not in data:
            return json_response({'error': 'Invalid request body or missing quizId/questions.'}, status=400)

        quiz_id = data['quizId']
        # Ensure 'expiresAt' is set, otherwise set it for 24 hours from now
        expires_at = data.get('expiresAt', int((datetime.now() + timedelta(days=1)).timestamp() * 1000))

        # Separate data into secure (with answers) and public (without answers)
        secure_quiz_data = data
        
        public_quiz_data = {
            k: v for k, v in data.items() if k not in ['questions']
        }
        # The public version only needs ID, name, totalPoints, etc., but not the full question list
        # For the frontend to fetch questions, it will call another function or use the quiz ID to locate them.
        
        # We store minimal metadata in the public collection and the full quiz (with answers) in admin collection
        public_quiz_data['quizId'] = quiz_id
        public_quiz_data['expiresAt'] = expires_at
        public_quiz_data['totalQuestions'] = len(data['questions'])


        # Step 3: Write to Firestore (Transaction not strictly needed here)
        secure_ref = db.collection(f'artifacts/{APP_ID}/admin/quizzes').document(quiz_id)
        public_ref = db.collection(f'artifacts/{APP_ID}/public/data/activeQuizzes').document(quiz_id)
        
        # Secure Write (Full quiz data including answers)
        secure_ref.set(secure_quiz_data)
        
        # Public Write (Quiz metadata)
        public_ref.set(public_quiz_data)

        return json_response({'message': f'Quiz {quiz_id} uploaded successfully.', 'quizId': quiz_id})

    except Exception as e:
        print(f"Error during admin quiz upload: {e}")
        return json_response({'error': 'Internal server error.'}, status=500)

# --- 2. GET ACTIVE QUIZZES FUNCTION ---
# Endpoint: GET /quiz/active

def get_active_quizzes(req):
# ... (function body remains the same) ...
    """
    Public function to fetch all currently active quiz IDs and metadata.
    Does NOT return correct answers.
    """
    if req.method == 'OPTIONS':
        return json_response('', status=204) # Handle preflight
        
    try:
        # Query active quizzes collection
        active_quizzes_ref = db.collection(f'artifacts/{APP_ID}/public/data/activeQuizzes')
        now = int(time.time() * 1000)
        
        # Filter for quizzes that have not yet expired
        q = active_quizzes_ref.where('expiresAt', '>', now)
        
        # Fetch data
        docs = q.stream()
        quizzes = []
        for doc in docs:
            quizzes.append(doc.to_dict())
        
        return json_response({'quizzes': quizzes})

    except Exception as e:
        print(f"Error fetching active quizzes: {e}")
        return json_response({'error': 'Internal server error.'}, status=500)

# --- 3. SCORE SUBMISSION AND VALIDATION FUNCTION (CRITICAL) ---
# Endpoint: POST /quiz/submit

def submit_quiz_score(req):
# ... (function body remains the same) ...
    """
    Secured function to validate user answers, calculate score, and update user profile using a transaction.
    """
    if req.method == 'OPTIONS':
        return json_response('', status=204) # Handle preflight

    try:
        # Step 1: Authentication
        user_id = get_user_id_from_token(req)
        if not user_id:
            return json_response({'error': 'Unauthorized: Missing or invalid token.'}, status=401)
        
        # Step 2: Data Validation
        data = req.get_json(silent=True)
        if not data or 'quizId' not in data or 'answers' not in data:
            return json_response({'error': 'Invalid payload.'}, status=400)

        quiz_id = data['quizId']
        answers = data['answers'] # Expected format: [{questionId: 1, selectedOption: "A"}, ...]

        # Step 3: Fetch Secure Quiz Data (Answers)
        secure_quiz_ref = db.collection(f'artifacts/{APP_ID}/admin/quizzes').document(quiz_id)
        secure_quiz_snap = secure_quiz_ref.get()

        if not secure_quiz_snap.exists:
            return json_response({'error': 'Quiz not found or expired.'}, status=404)
        
        secure_quiz = secure_quiz_snap.to_dict()
        points_per_question = secure_quiz.get('totalPoints', 0) / secure_quiz.get('totalQuestions', 1)
        
        # Create a map for quick lookup of correct answers
        correct_map = {q['questionId']: q['correctAnswer'] for q in secure_quiz.get('questions', [])}

        # Step 4: Server-Side Score Calculation
        correct_count = 0
        total_answered = 0
        
        for answer in answers:
            q_id = answer.get('questionId')
            selected = answer.get('selectedOption')
            
            if q_id in correct_map and selected is not None:
                total_answered += 1
                if selected == correct_map[q_id]:
                    correct_count += 1

        points_earned = int(correct_count * points_per_question)

        # Step 5: Update User Profile (Firestore Transaction)
        user_profile_ref = db.document(f'artifacts/{APP_ID}/users/{user_id}/gameData/profile')
        
        try:
            @firestore.transactional
            def update_user_score_transaction(transaction, profile_ref, points, quiz_id, score_details):
                snapshot = profile_ref.get(transaction=transaction)
                
                # Check if user has already submitted this quiz
                if snapshot.exists and snapshot.get(f'quizzes_completed.{quiz_id}'):
                    raise ValueError("Quiz already completed by this user.")

                current_score = snapshot.get('score') or 0
                new_score = current_score + points
                
                # Update user data
                transaction.set(profile_ref, {
                    'score': new_score,
                    'leagueScore': new_score, # Typically league score is the same as global score
                    'globalRank': '#calculating', # Rank is updated by a separate scheduled function
                    f'quizzes_completed.{quiz_id}': firestore.SERVER_TIMESTAMP, # Mark as completed
                    f'latest_submission.{quiz_id}': score_details # Optional: store details
                }, merge=True)
                
                return new_score

            new_total_score = update_user_score_transaction(
                db.transaction(), 
                user_profile_ref, 
                points_earned, 
                quiz_id,
                {'points': points_earned, 'correct': correct_count, 'total': total_answered}
            )

            # Step 6: Success Response
            return json_response({
                'message': 'Score submitted and validated successfully.',
                'pointsEarned': points_earned,
                'correctCount': correct_count,
                'totalScore': new_total_score
            })

        except TimeoutError:
             return json_response({'error': 'Transaction timed out. Try again.'}, status=503)
        except ValueError as ve:
             return json_response({'error': str(ve)}, status=409) # 409 Conflict for duplicate submission
        except Exception as te:
            print(f"Firestore Transaction Error: {te}")
            return json_response({'error': 'Failed to update score due to transaction error.'}, status=500)

    except Exception as e:
        print(f"Unhandled error in submit_quiz_score: {e}")
        return json_response({'error': 'Internal server error.'}, status=500)

# --- 4. LEADERBOARD RETRIEVAL FUNCTION ---
# Endpoint: GET /leaderboard/global

def get_global_leaderboard(req):
# ... (function body remains the same) ...
    """
    Public function to fetch a simple global leaderboard.
    NOTE: This is not optimized for massive scale. For production, use BigQuery/scheduled functions.
    """
    if req.method == 'OPTIONS':
        return json_response('', status=204) # Handle preflight

    try:
        # Query all user profiles (limited to prevent excessive reads)
        users_ref = db.collection(f'artifacts/{APP_ID}/users')
        
        # We need to query the 'gameData' subcollection in a complex way.
        # Since this structure is not simple for a single collection query, we simulate the fetch:
        
        # 1. Fetch the user documents who have a 'gameData/profile' subcollection (simulated)
        # In a real app, you would have a single indexed 'LeaderboardEntries' collection.
        
        # SIMULATED Leaderboard fetch (Top 50 by score)
        # A real production setup would require a dedicated leaderboard collection
        
        leaderboard_ref = db.collection(f'artifacts/{APP_ID}/public/data/leaderboard')
        
        # Fetch top 50 entries
        q = leaderboard_ref.order_by('score', direction=firestore.Query.DESCENDING).limit(50)
        
        docs = q.stream()
        leaderboard = []
        rank = 1
        for doc in docs:
            data = doc.to_dict()
            leaderboard.append({
                'rank': rank,
                'userId': doc.id,
                'name': data.get('name', 'Player'),
                'score': data.get('score', 0)
            })
            rank += 1
            
        return json_response({'leaderboard': leaderboard})

    except Exception as e:
        print(f"Error fetching leaderboard: {e}")
        return json_response({'error': 'Internal server error.'}, status=500)
