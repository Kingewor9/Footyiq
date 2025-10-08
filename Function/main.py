import os
import time
import json
import hashlib
import hmac
import urllib.parse
from datetime import datetime, timedelta
import random

# Import Firebase Admin/Functions SDKs
import firebase_admin
from firebase_admin import firestore, auth
from firebase_functions import https_fn, options
from firebase_admin.exceptions import FirebaseError

# --- Configuration and Initialization ---

# Initialize Firebase Admin SDK (must be called only once)
if not firebase_admin._apps:
    try:
        firebase_admin.initialize_app()
    except ValueError as e:
        print(f"Firebase initialization error (might be okay if already initialized): {e}")

db = firestore.client()

# IMPORTANT: These must be set as environment variables during deployment:
# Example: firebase functions:config:set app.id="[YOUR_APP_ID]"
APP_ID = os.environ.get('APP_ID', 'default-footy-iq-app-id') 
ADMIN_USER_ID = os.environ.get('ADMIN_USER_ID') # Your Telegram/Firebase UID
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')


# --- Utility Functions ---

def get_user_id_from_token(req: https_fn.Request) -> str | None:
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

def verify_telegram_data(init_data: str) -> dict | None:
    """
    Cryptographically verifies the Telegram WebApp initData hash using the Bot Token.
    Returns the verified data dictionary if successful, or None if validation fails.
    (Adopted official Telegram verification method from your provided code.)
    """
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN not set in environment variables.")
        return None
    
    # 1. Separate hash from other parameters
    parsed_data = urllib.parse.parse_qs(init_data)
    
    if 'hash' not in parsed_data:
        return None
        
    hash_value = parsed_data.pop('hash')[0]

    # 2. Sort and concatenate parameters (excluding hash)
    # The sort order is crucial for verification
    check_string = '&'.join([
        f'{key}={value[0]}' 
        for key, value in sorted(parsed_data.items())
    ])

    # 3. Calculate Secret Key
    secret_key = hmac.new(
        key=b"WebAppData",
        # Use the Telegram Bot Token for HMAC key creation
        msg=TELEGRAM_BOT_TOKEN.encode(),
        digestmod=hashlib.sha256
    ).digest()

    # 4. Calculate HMAC against the check string
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

# --- 0. TELEGRAM AUTH BRIDGE FUNCTION ---
# Endpoint: POST /auth/telegram
@https_fn.on_request(
    cors=options.CorsOptions(allow_methods=["POST"], allow_origin=["*"]) 
)
def telegram_auth_bridge(req: https_fn.Request) -> https_fn.Response:
    """
    Secures the Telegram Mini App by verifying initData and minting a Firebase Custom Token.
    """
    if req.method != 'POST':
        return https_fn.Response("Method Not Allowed", status=405)

    try:
        data = req.get_json(silent=True)
        init_data = data.get('initData')
        
        if not init_data:
            return https_fn.Response(json.dumps({'error': 'Missing initData in payload.'}), status=400, content_type="application/json")

        telegram_user = verify_telegram_data(init_data)

        if not telegram_user:
            return https_fn.Response(json.dumps({'error': 'Invalid or expired Telegram initiation data.'}), status=401, content_type="application/json")

        # Extract Telegram User ID (UID for Firebase)
        telegram_uid = str(telegram_user['id'])
        
        # Mint the Firebase Custom Token
        custom_token = auth.create_custom_token(telegram_uid, {
            'telegram_id': telegram_uid,
            'username': telegram_user.get('username'),
            'first_name': telegram_user.get('first_name')
        })

        # Ensure User Profile Exists (Initialize profile data if first login)
        user_profile_ref = db.document(f'artifacts/{APP_ID}/users/{telegram_uid}/gameData/profile')
        user_profile_ref.set({
            'telegram_id': telegram_uid,
            'name': telegram_user.get('first_name', 'Player') + (f" ({telegram_user.get('username')})" if telegram_user.get('username') else ""),
            'score': 0,
            'last_login': firestore.SERVER_TIMESTAMP
        }, merge=True)

        return https_fn.Response(json.dumps({'customToken': custom_token.decode('utf-8')}), status=200, content_type="application/json")

    except Exception as e:
        print(f"Error in Telegram Auth Bridge: {e}")
        return https_fn.Response(json.dumps({'error': 'Internal authentication error.'}), status=500, content_type="application/json")

# --- 1. ADMIN QUIZ UPLOAD FUNCTION ---
# Endpoint: POST /admin/upload_quiz
@https_fn.on_request(
    cors=options.CorsOptions(allow_methods=["POST"], allow_origin=["*"]) 
)
def admin_upload_quiz(req: https_fn.Request) -> https_fn.Response:
    """
    Secured function to upload a new quiz to Firestore. 
    Requires valid Firebase ID Token and matching ADMIN_USER_ID.
    """
    if req.method != 'POST':
        return https_fn.Response("Method Not Allowed", status=405)

    try:
        # Step 1: Authentication and Authorization Check
        user_id = get_user_id_from_token(req)
        if not user_id:
            return https_fn.Response(json.dumps({'error': 'Unauthorized: Missing or invalid token.'}), status=401, content_type="application/json")
            
        if user_id != ADMIN_USER_ID:
            print(f"Unauthorized admin attempt by user: {user_id}")
            return https_fn.Response(json.dumps({'error': 'Forbidden: User is not the designated admin.'}), status=403, content_type="application/json")

        # Step 2: Parse and Validate Data
        data = req.get_json(silent=True)
        if not data or 'quizId' not in data or 'questions' not in data:
            return https_fn.Response(json.dumps({'error': 'Invalid request body or missing quizId/questions.'}), status=400, content_type="application/json")

        quiz_id = data['quizId']
        # Ensure 'expiresAt' is set, otherwise set it for 24 hours from now
        expires_at = data.get('expiresAt', int((datetime.now() + timedelta(days=1)).timestamp() * 1000))

        # Separate data into secure (with answers) and public (without answers)
        secure_quiz_data = data
        
        public_quiz_data = {
            k: v for k, v in data.items() if k not in ['questions']
        }
        
        public_quiz_data['quizId'] = quiz_id
        public_quiz_data['expiresAt'] = expires_at
        public_quiz_data['totalQuestions'] = len(data['questions'])


        # Step 3: Write to Firestore 
        secure_ref = db.collection(f'artifacts/{APP_ID}/admin/quizzes').document(quiz_id)
        public_ref = db.collection(f'artifacts/{APP_ID}/public/data/activeQuizzes').document(quiz_id)
        
        # Secure Write (Full quiz data including answers)
        secure_ref.set(secure_quiz_data)
        
        # Public Write (Quiz metadata)
        public_ref.set(public_quiz_data)

        return https_fn.Response(json.dumps({'message': f'Quiz {quiz_id} uploaded successfully.', 'quizId': quiz_id}), status=200, content_type="application/json")

    except Exception as e:
        print(f"Error during admin quiz upload: {e}")
        return https_fn.Response(json.dumps({'error': 'Internal server error.'}), status=500, content_type="application/json")

# --- 2. GET ACTIVE QUIZZES FUNCTION ---
# Endpoint: GET /quiz/active
@https_fn.on_request(
    cors=options.CorsOptions(allow_methods=["GET"], allow_origin=["*"]) 
)
def get_active_quizzes(req: https_fn.Request) -> https_fn.Response:
    """
    Public function to fetch all currently active quiz IDs and metadata.
    """
    if req.method != 'GET':
        return https_fn.Response("Method Not Allowed", status=405)
        
    try:
        active_quizzes_ref = db.collection(f'artifacts/{APP_ID}/public/data/activeQuizzes')
        now = int(time.time() * 1000)
        
        # Filter for quizzes that have not yet expired
        q = active_quizzes_ref.where('expiresAt', '>', now)
        
        # Fetch data
        docs = q.stream()
        quizzes = []
        for doc in docs:
            quizzes.append(doc.to_dict())
        
        return https_fn.Response(json.dumps({'quizzes': quizzes}), status=200, content_type="application/json")

    except Exception as e:
        print(f"Error fetching active quizzes: {e}")
        return https_fn.Response(json.dumps({'error': 'Internal server error.'}), status=500, content_type="application/json")

# --- 3. SCORE SUBMISSION AND VALIDATION FUNCTION (CRITICAL) ---
# Endpoint: POST /quiz/submit
@https_fn.on_request(
    cors=options.CorsOptions(allow_methods=["POST"], allow_origin=["*"]) 
)
def submit_quiz_score(req: https_fn.Request) -> https_fn.Response:
    """
    Secured function to validate user answers, calculate score, and update user profile using a transaction.
    """
    if req.method != 'POST':
        return https_fn.Response("Method Not Allowed", status=405)

    try:
        # Step 1: Authentication
        user_id = get_user_id_from_token(req)
        if not user_id:
            return https_fn.Response(json.dumps({'error': 'Unauthorized: Missing or invalid token.'}), status=401, content_type="application/json")
        
        # Step 2: Data Validation
        data = req.get_json(silent=True)
        if not data or 'quizId' not in data or 'answers' not in data:
            return https_fn.Response(json.dumps({'error': 'Invalid payload.'}), status=400, content_type="application/json")

        quiz_id = data['quizId']
        answers = data['answers'] 

        # Step 3: Fetch Secure Quiz Data (Answers)
        secure_quiz_ref = db.collection(f'artifacts/{APP_ID}/admin/quizzes').document(quiz_id)
        secure_quiz_snap = secure_quiz_ref.get()

        if not secure_quiz_snap.exists:
            return https_fn.Response(json.dumps({'error': 'Quiz not found or expired.'}), status=404, content_type="application/json")
        
        secure_quiz = secure_quiz_snap.to_dict()
        
        # Handle case where quiz data is missing score info (prevent division by zero)
        total_questions = secure_quiz.get('totalQuestions') or len(secure_quiz.get('questions', []))
        total_points = secure_quiz.get('totalPoints') or (total_questions * 10) # Default to 10 points per question
        
        if total_questions == 0:
             return https_fn.Response(json.dumps({'error': 'Quiz structure is invalid (0 questions).'}), status=400, content_type="application/json")
             
        points_per_question = total_points / total_questions
        
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
                    'leagueScore': new_score, 
                    'globalRank': '#calculating', 
                    f'quizzes_completed.{quiz_id}': firestore.SERVER_TIMESTAMP, 
                    f'latest_submission.{quiz_id}': score_details 
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
            return https_fn.Response(
                json.dumps({
                    'message': 'Score submitted and validated successfully.',
                    'pointsEarned': points_earned,
                    'correctCount': correct_count,
                    'totalScore': new_total_score
                }), 
                status=200, 
                content_type="application/json"
            )

        except TimeoutError:
            return https_fn.Response(json.dumps({'error': 'Transaction timed out. Try again.'}), status=503, content_type="application/json")
        except ValueError as ve:
            return https_fn.Response(json.dumps({'error': str(ve)}), status=409, content_type="application/json") # 409 Conflict for duplicate submission
        except Exception as te:
            print(f"Firestore Transaction Error: {te}")
            return https_fn.Response(json.dumps({'error': 'Failed to update score due to transaction error.'}), status=500, content_type="application/json")

    except Exception as e:
        print(f"Unhandled error in submit_quiz_score: {e}")
        return https_fn.Response(json.dumps({'error': 'Internal server error.'}), status=500, content_type="application/json")

# --- 4. LEADERBOARD RETRIEVAL FUNCTION ---
# Endpoint: GET /leaderboard/global
@https_fn.on_request(
    cors=options.CorsOptions(allow_methods=["GET"], allow_origin=["*"]) 
)
def get_global_leaderboard(req: https_fn.Request) -> https_fn.Response:
    """
    Public function to fetch a simple global leaderboard.
    """
    if req.method != 'GET':
        return https_fn.Response("Method Not Allowed", status=405)

    try:
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
            
        return https_fn.Response(json.dumps({'leaderboard': leaderboard}), status=200, content_type="application/json")

    except Exception as e:
        print(f"Error fetching leaderboard: {e}")
        return https_fn.Response(json.dumps({'error': 'Internal server error.'}), status=500, content_type="application/json")
