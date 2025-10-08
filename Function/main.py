import os
import json
import hmac
import hashlib
from urllib.parse import parse_qs, urlparse

# Import Firebase Admin SDK to handle authentication and token minting
import firebase_admin
from firebase_admin import credentials, auth
from firebase_functions import https_fn, options

# --- Configuration and Initialization ---
# Initialize the Firebase Admin SDK. 
# This uses the credentials automatically provided by the Firebase Functions environment.
if not firebase_admin._apps:
    firebase_admin.initialize_app()

# NOTE: The bot token is sensitive data. 
# In production, use Firebase environment configuration: os.environ.get("TELEGRAM_BOT_TOKEN")
# For this example, replace 'YOUR_TELEGRAM_BOT_TOKEN' with your actual bot token.
TELEGRAM_BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN"

def verify_telegram_data(init_data: str) -> dict:
    """
    Verifies the integrity of the Telegram WebApp initData parameter.
    
    Args:
        init_data: The string of key=value pairs provided by Telegram WebApp.
        
    Returns:
        A dictionary containing verified user data if successful.
        
    Raises:
        ValueError if the check fails.
    """
    # 1. Separate the hash from the other data fields.
    params = parse_qs(init_data, keep_blank_values=True)
    hash_value = params.pop('hash', [None])[0]

    if not hash_value:
        raise ValueError("Init data is missing the 'hash' parameter.")

    # 2. Sort the remaining key-value pairs alphabetically and format them.
    data_check_string = "\n".join([
        f"{key[0]}={params[key][0]}"
        for key in sorted(params.keys())
    ])

    # 3. Create the secret key (Hashed BOT_TOKEN)
    secret_key = hashlib.sha256(TELEGRAM_BOT_TOKEN.encode()).digest()

    # 4. Calculate HMAC-SHA256 signature.
    calculated_hash = hmac.new(
        key=secret_key,
        msg=data_check_string.encode(),
        digestmod=hashlib.sha256
    ).hexdigest()

    # 5. Compare the calculated hash with the received hash.
    if calculated_hash != hash_value:
        raise ValueError("Data verification failed. Hash mismatch.")

    # 6. Extract user ID (for Firebase UID)
    if 'user' in params:
        user_data_str = params['user'][0]
        user_data = json.loads(user_data_str)
        return user_data
    
    raise ValueError("Init data is missing user information.")


@https_fn.on_request(
    # Set CORS headers to allow calls from your frontend (running in the Telegram context)
    cors=options.CorsOptions(allow_methods=["POST"], allow_origin=["*"]) 
)
def telegram_auth_bridge(req: https_fn.Request) -> https_fn.Response:
    """
    Firebase Function to verify Telegram initData and return a custom Firebase Token.
    """
    # Only allow POST requests
    if req.method != 'POST':
        return https_fn.Response("Method Not Allowed", status=405)

    try:
        # Get data from the POST request
        request_json = req.get_json(silent=True)
        if not request_json or 'initData' not in request_json:
            return https_fn.Response(json.dumps({"error": "Missing initData in request"}), status=400, content_type="application/json")
        
        init_data = request_json['initData']
        
        # Verify the Telegram data
        user_data = verify_telegram_data(init_data)
        
        # Use Telegram user ID as the Firebase User ID (UID)
        telegram_id = str(user_data['id'])
        
        # Create a custom token for the verified user
        # This token is sent to the client, which uses it to sign in to Firebase.
        custom_token = auth.create_custom_token(
            uid=telegram_id,
            # Optional: Add custom claims for security rules (e.g., 'telegram_verified': True)
            developer_claims={"telegram_id": telegram_id}
        )
        
        # Return the token to the client
        response_data = {
            "customToken": custom_token.decode('utf-8'),
            "telegramId": telegram_id,
        }

        return https_fn.Response(
            json.dumps(response_data), 
            status=200, 
            content_type="application/json"
        )
        
    except ValueError as e:
        # Handle verification failures (hash mismatch, invalid data)
        print(f"Authentication verification error: {e}")
        return https_fn.Response(
            json.dumps({"error": "Unauthorized: Verification failed."}), 
            status=401, 
            content_type="application/json"
        )
    except Exception as e:
        # Handle all other errors (e.g., Firebase Auth errors)
        print(f"Server error: {e}")
        return https_fn.Response(
            json.dumps({"error": "Internal server error during token creation."}), 
            status=500, 
            content_type="application/json"
        )
