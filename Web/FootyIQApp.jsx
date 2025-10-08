import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, setDoc, runTransaction, collection, query, where, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { BarChart2, Shield, Users, User, Home, Zap, Clock, TrendingUp, Search, Plus, LogIn, Lock, CheckCircle, XCircle, LogOut } from 'lucide-react';

// --- GLOBAL VARIABLES & CONFIGURATION ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-footy-iq-app-id';

// --- API ENDPOINT CONFIGURATION ---
const AUTH_BRIDGE_URL = 'https://YOUR-PROJECT.cloudfunctions.net/telegram_auth_bridge'; // For secure sign-in
const SUBMIT_SCORE_URL = 'https://YOUR-PROJECT.cloudfunctions.net/submit_quiz_score';
const GET_QUIZ_URL = 'https://YOUR-PROJECT.cloudfunctions.net/get_active_quizzes';
const GET_LEADERBOARD_URL = 'https://YOUR-PROJECT.cloudfunctions.net/get_global_leaderboard';

// --- SIMULATED DATA (Replace with API Calls) ---
const QUIZ_DATA_MOCK = {
    quizId: 'quiz_01_20250101',
    name: "New Year's Football Legends",
    totalQuestions: 25,
    timeLimitSeconds: 90,
    totalPoints: 250,
    expiresAt: Date.now() + 86400000, // Expires 24 hours from now
};

const DEFAULT_LEAGUES = [
    { id: '1', name: 'Global Football Fans', description: 'The biggest league for worldwide footy knowledge.', rank: 15, points: 12400, members: 5000, isOwner: false },
    { id: '2', name: 'Premier League Gurus', description: 'Strictly for PL enthusiasts.', rank: 3, points: 5120, members: 120, isOwner: true },
    { id: '3', name: 'Champions League Buffs', description: 'Test your UCL history here.', rank: 1, points: 9800, members: 750, isOwner: false },
];

const DAILY_TASKS = [
    { name: 'Join our Telegram Channel', points: 100, action: 'Join', link: 'https://t.me/YourChannel' },
    { name: 'Invite 5 friends to join the game', points: 1000, action: 'Invite', link: 'https://t.me/share/url?url=...' },
    { name: 'Watch a free ad', points: 500, action: 'Go', link: '#' },
];

const MOCK_QUESTIONS = Array.from({ length: 25 }, (_, i) => ({
    questionId: i + 1,
    text: `Who won the FIFA World Cup in 20${14 + i % 4}? (Mock Question ${i + 1})`,
    options: ['Germany', 'Brazil', 'Argentina', 'France'],
}));


// --- Firebase Initialization ---
let app, db, auth;
if (Object.keys(firebaseConfig).length > 0) {
    try {
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);
        // setLogLevel('debug'); // Optional: for debugging
    } catch (e) {
        console.error("Firebase initialization failed:", e);
    }
}

// Global styles definition for cleaner component structure
const appStylesDefinition = {
    container: `min-h-screen p-4 pb-16 font-sans transition-colors duration-300`,
    card: `p-4 rounded-xl shadow-lg mb-4`,
    button: `py-3 px-6 rounded-xl font-bold transition-transform transform active:scale-98 w-full`,
    navIcon: 'w-6 h-6',
    input: 'w-full p-3 rounded-lg border-2 mb-3 focus:outline-none transition-colors duration-200',
};

const App = () => {
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [activePage, setActivePage] = useState('Home');
    const [userData, setUserData] = useState(null);
    const [quizData, setQuizData] = useState(QUIZ_DATA_MOCK);
    const [countdown, setCountdown] = useState(0);
    const [leagues, setLeagues] = useState(DEFAULT_LEAGUES);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    // Quiz State
    const [isQuizActive, setIsQuizActive] = useState(false);
    const [quizCurrentQuestion, setQuizCurrentQuestion] = useState(0);
    const [quizTimeLeft, setQuizTimeLeft] = useState(QUIZ_DATA_MOCK.timeLimitSeconds);
    const [quizResults, setQuizResults] = useState(null);
    const [quizAnswers, setQuizAnswers] = useState([]);
    const [quizFeedback, setQuizFeedback] = useState(null); 

    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [modalType, setModalType] = useState(null);
    const [leagueFormData, setLeagueFormData] = useState({ name: '', description: '', isPrivate: false, code: '' });

    // --- TELEGRAM WEB APP SDK & THEME STYLING ---
    const webApp = useMemo(() => {
        if (typeof window.Telegram !== 'undefined' && window.Telegram.WebApp) {
            window.Telegram.WebApp.ready();
            return window.Telegram.WebApp;
        }
        return null;
    }, []);

    const THEME_COLORS = useMemo(() => {
        if (webApp && webApp.colorScheme === 'dark') {
            return {
                bg: webApp.themeParams.bg_color || '#181f27',
                cardBg: webApp.themeParams.secondary_bg_color || '#202a36',
                text: webApp.themeParams.text_color || '#ffffff',
                hint: webApp.themeParams.hint_color || '#8c98a5',
                accent: webApp.themeParams.button_color || '#007aff',
                buttonText: webApp.themeParams.button_text_color || '#ffffff',
                success: '#28a745',
                failure: '#dc3545',
            };
        }
        return {
            bg: '#181f27',
            cardBg: '#202a36',
            text: '#ffffff',
            hint: '#8c98a5',
            accent: '#007aff',
            buttonText: '#ffffff',
            success: '#28a745',
            failure: '#dc3545',
        };
    }, [webApp]);
    
    const appStyles = appStylesDefinition; // Use defined styles

    // --- API CALL HELPERS ---

    const fetchWithAuth = useCallback(async (url, options = {}) => {
        if (!auth || !auth.currentUser) {
            throw new Error("Authentication not ready or user not logged in.");
        }
        
        const token = await auth.currentUser.getIdToken();

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...options.headers,
        };

        const response = await fetch(url, {
            ...options,
            headers,
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Unknown API error' }));
            throw new Error(errorData.error || `API call failed with status ${response.status}`);
        }

        return response.json();
    }, [auth]);

    // --- FIREBASE/TELEGRAM AUTHENTICATION BRIDGE ---

    const handleSecureAuth = useCallback(async () => {
        if (!auth || userId) return;

        try {
            const initData = webApp?.initData;
            
            if (initData) {
                const response = await fetch(AUTH_BRIDGE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ initData })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || 'Failed to verify Telegram data on backend.');
                }
                
                const { customToken } = await response.json();
                await signInWithCustomToken(auth, customToken);
                
            } else if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                 await signInWithCustomToken(auth, __initial_auth_token);
            } else {
                // Should not happen in Canvas environment, but for safety
                console.warn("No token available. Attempting anonymous sign-in.");
                // await signInAnonymously(auth); 
            }
        } catch (error) {
            console.error("Secure Authentication Failed:", error);
            setError("Authentication failed. Please relaunch the app from Telegram.");
        } finally {
            // Ensure this runs even if sign-in fails, to stop the loading screen
            setIsAuthReady(true);
            setIsLoading(false);
        }
    }, [auth, webApp, userId]);


    // --- EFFECT: FIREBASE AUTH LISTENER & INITIAL AUTH ---
    useEffect(() => {
        if (!auth) {
            setError("Firebase not initialized. Check configuration.");
            setIsAuthReady(true);
            setIsLoading(false);
            return;
        }

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user) {
                setUserId(user.uid);
            } else {
                setUserId(null);
            }
            // setIsAuthReady is now set inside handleSecureAuth's finally block to prevent flickering
        });

        if (!userId && !isAuthReady) {
            handleSecureAuth();
        }

        return () => unsubscribe();
    }, [auth, handleSecureAuth, isAuthReady, userId]);


    // --- EFFECT: DATA LISTENERS (User Data and Quiz Timer) ---
    useEffect(() => {
        if (!db || !userId) return;

        // 1. User Data Listener
        const userRef = doc(db, `artifacts/${appId}/users/${userId}/gameData/profile`);
        const unsubscribeUser = onSnapshot(userRef, (docSnap) => {
            if (docSnap.exists()) {
                setUserData(docSnap.data());
            } else {
                // Initialize profile
                console.log("Creating initial user profile.");
                setDoc(userRef, { 
                    score: 0, 
                    leagueScore: 0, 
                    name: webApp?.initDataUnsafe?.user?.first_name || 'Player', 
                    globalRank: 'N/A' 
                }, { merge: true }).catch(err => console.error("Profile creation error:", err));
            }
        }, (error) => {
            console.error("Error listening to user data:", error);
        });

        // 2. Quiz Metadata Fetcher (Using interval for mock API polling)
        const fetchActiveQuiz = async () => {
             try {
                // Simulated API call for active quiz data
                const data = await fetch(GET_QUIZ_URL).then(res => res.json()).catch(() => ({ quizzes: [{...QUIZ_DATA_MOCK}] })); 
                
                if (data.quizzes && data.quizzes.length > 0) {
                    const quiz = data.quizzes[0];
                    setQuizData(quiz);
                    // Ensure countdown calculation uses the correct property (e.g., expiresAt)
                    setCountdown(Math.max(0, (quiz.expiresAt || QUIZ_DATA_MOCK.expiresAt) - Date.now()));
                } else {
                    setQuizData(null);
                    setCountdown(0);
                }
            } catch (err) {
                console.error("Failed to fetch active quiz:", err);
                setQuizData(QUIZ_DATA_MOCK); // Fallback
                setCountdown(Math.max(0, QUIZ_DATA_MOCK.expiresAt - Date.now()));
            }
        };

        fetchActiveQuiz();
        const quizPollInterval = setInterval(fetchActiveQuiz, 30000);

        return () => {
            unsubscribeUser();
            clearInterval(quizPollInterval);
        };
    }, [db, userId, webApp]);

    // --- EFFECT: COUNTDOWN TIMER ---
    useEffect(() => {
        if (countdown <= 0) return;

        const interval = setInterval(() => {
            setCountdown(prev => Math.max(0, prev - 1000));
        }, 1000);

        return () => clearInterval(interval);
    }, [countdown]);
    
    // --- EFFECT: QUIZ TIME LEFT TIMER ---
    useEffect(() => {
        if (!isQuizActive || quizTimeLeft <= 0) {
            if (isQuizActive && quizTimeLeft <= 0) {
                handleQuizFinish(true); // Finish quiz due to timeout
            }
            return;
        }

        const timer = setInterval(() => {
            setQuizTimeLeft(prev => prev - 1);
        }, 1000);

        return () => clearInterval(timer);
    }, [isQuizActive, quizTimeLeft]);

    // --- HELPERS ---

    const handleSignOut = () => {
        if (auth) {
            signOut(auth).then(() => {
                setUserId(null);
                setUserData(null);
                setActivePage('Home');
                setIsAuthReady(false); // Force re-auth
            }).catch(e => console.error("Sign out failed:", e));
        }
    };

    const formatTime = (ms) => {
        if (ms <= 0) return "EXPIRED";
        const totalSeconds = Math.floor(ms / 1000);
        const days = Math.floor(totalSeconds / (3600 * 24));
        const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (days > 0) {
             return `${days}d ${hours}h`;
        }
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    };

    const isQuizCompleted = useMemo(() => {
        if (!userData || !quizData) return false;
        // Mock check for completion using a property that would normally be updated by the server
        return userData.quizzes_completed && userData.quizzes_completed[quizData.quizId]; 
    }, [userData, quizData]);

    // --- QUIZ LOGIC ---
    
    const handleStartQuiz = () => {
        if (isQuizCompleted) {
            console.log('Quiz already completed.');
            return;
        }
        setQuizCurrentQuestion(0);
        setQuizTimeLeft(quizData.timeLimitSeconds);
        setQuizAnswers([]);
        setQuizResults(null);
        setIsQuizActive(true);
        webApp?.HapticFeedback?.impactOccurred('light'); 
    };

    const handleAnswer = (selectedOption) => {
        const questionId = MOCK_QUESTIONS[quizCurrentQuestion].questionId;
        
        // --- MOCK FEEDBACK (Security: Real feedback should come from the server) ---
        const isCorrect = Math.random() < 0.7; 

        setQuizFeedback({
            status: isCorrect ? 'correct' : 'wrong',
            correctOption: isCorrect ? selectedOption : 'A' // Placeholder for real correct answer
        });
        
        webApp?.HapticFeedback?.impactOccurred(isCorrect ? 'success' : 'error');

        const newAnswer = { questionId, selectedOption };
        setQuizAnswers(prev => [...prev, newAnswer]);

        setTimeout(() => {
            setQuizFeedback(null);
            if (quizCurrentQuestion < MOCK_QUESTIONS.length - 1) {
                setQuizCurrentQuestion(prev => prev + 1);
            } else {
                handleQuizFinish(false);
            }
        }, 500);
    };

    const handleQuizFinish = async (isTimeout) => {
        setIsQuizActive(false);
        setIsLoading(true);

        const dataToSend = {
            userId: userId,
            quizId: quizData.quizId,
            answers: quizAnswers,
        };

        try {
            // Mock server response
            const mockResult = {
                totalCount: quizAnswers.length,
                correctCount: Math.round(quizAnswers.length * 0.7),
                pointsEarned: Math.round(quizAnswers.length * 0.7 * 10),
                totalScore: (userData?.score || 0) + Math.round(quizAnswers.length * 0.7 * 10)
            };
            
            // In a real app: const result = await fetchWithAuth(SUBMIT_SCORE_URL, { ... })
            const result = mockResult;

            setQuizResults({
                answered: result.totalCount,
                correct: result.correctCount,
                points: result.pointsEarned,
                accuracy: result.totalCount > 0 ? ((result.correctCount / result.totalCount) * 100).toFixed(1) : 0,
                isTimeout: isTimeout,
                newTotalScore: result.totalScore
            });

        } catch (error) {
            console.error("Score submission failed:", error.message);
            setError(error.message);
            setQuizResults({ answered: quizAnswers.length, correct: 0, points: 0, accuracy: 0, isTimeout: isTimeout, newTotalScore: userData?.score || 0 });
        } finally {
            setIsLoading(false);
        }
    };

    // --- LEAGUE LOGIC ---

    const handleOpenModal = (type) => {
        setModalType(type);
        setIsModalOpen(true);
        setLeagueFormData({ name: '', description: '', isPrivate: false, code: '' });
    };
    
    const handleModalSubmit = async () => {
        if (!db || !userId) return console.error("Authentication required.");

        setIsLoading(true);
        try {
            if (modalType === 'create') {
                if (!leagueFormData.name || !leagueFormData.description) return alert("Please fill in required fields.");

                const leagueRef = collection(db, `artifacts/${appId}/public/data/leagues`);
                const leagueCode = leagueFormData.isPrivate ? Math.random().toString(36).substring(2, 8).toUpperCase() : null;

                const newLeague = {
                    name: leagueFormData.name,
                    description: leagueFormData.description,
                    isPrivate: leagueFormData.isPrivate,
                    code: leagueCode,
                    ownerId: userId,
                    createdAt: serverTimestamp(),
                    memberCount: 1,
                    // Note: Simplified members structure for the mock
                };

                const docRef = await addDoc(leagueRef, newLeague);

                const userLeagueRef = doc(db, `artifacts/${appId}/users/${userId}/gameData/myLeagues`, docRef.id);
                await setDoc(userLeagueRef, { leagueId: docRef.id, isOwner: true, score: userData?.leagueScore || 0 });

                // Update local list (Mock)
                setLeagues(prev => [...prev, {
                    id: docRef.id,
                    ...newLeague,
                    rank: 1,
                    points: userData?.leagueScore || 0,
                    members: 1,
                    isOwner: true
                }]);

                console.log(`League created! Code: ${leagueCode || 'N/A'}`);
            } else if (modalType === 'join') {
                if (!leagueFormData.code) return alert("Please enter the 6-digit code.");

                const leagueQuery = query(collection(db, `artifacts/${appId}/public/data/leagues`), 
                                          where('code', '==', leagueFormData.code.toUpperCase()));
                const querySnapshot = await getDocs(leagueQuery);

                if (querySnapshot.empty) {
                    alert("No private league found with that code.");
                    return;
                }

                const leagueDoc = querySnapshot.docs[0];
                const leagueId = leagueDoc.id;
                const leagueData = leagueDoc.data();

                // Join the league
                await runTransaction(db, async (transaction) => {
                    const leagueRef = doc(db, `artifacts/${appId}/public/data/leagues`, leagueId);
                    const userLeagueRef = doc(db, `artifacts/${appId}/users/${userId}/gameData/myLeagues`, leagueId);
                    
                    // Transactional logic goes here...
                    // For the sake of simplicity in this single-file app, we'll skip the full transaction logic
                    // and rely on a simpler update and set for mock joining.

                    // Mock update
                    transaction.set(userLeagueRef, { leagueId: leagueId, isOwner: false, score: userData?.leagueScore || 0 });
                });
                
                // Update local list (Mock)
                setLeagues(prev => [...prev, {
                    id: leagueId,
                    name: leagueData.name,
                    description: leagueData.description,
                    rank: 99,
                    points: userData?.leagueScore || 0,
                    members: (leagueData.memberCount || 0) + 1,
                    isOwner: false
                }]);

                alert(`Successfully joined league: ${leagueData.name}`);
            }
            setIsModalOpen(false);
        } catch (error) {
            console.error("League action failed:", error);
            alert(`Failed to complete action: ${error.message}`);
        } finally {
            setIsLoading(false);
        }
    };

    // --- RENDER SECTIONS ---

    const QuizResultsModal = () => (
        <div style={{ backgroundColor: THEME_COLORS.cardBg }} className="p-6 rounded-xl text-center w-full max-w-sm">
            <h2 className="text-2xl font-extrabold mb-4" style={{ color: THEME_COLORS.accent }}>
                Quiz Finished!
            </h2>
            {quizResults.isTimeout && (
                 <p className="text-red-400 mb-2">Time ran out!</p>
            )}
            <div className="space-y-2 text-left">
                <p className="flex justify-between">
                    <span style={{ color: THEME_COLORS.hint }}>Questions Answered:</span> 
                    <span style={{ color: THEME_COLORS.text }}>{quizResults.answered}</span>
                </p>
                <p className="flex justify-between">
                    <span style={{ color: THEME_COLORS.hint }}>Correct Answers:</span> 
                    <span style={{ color: THEME_COLORS.success }}>{quizResults.correct}</span>
                </p>
                <p className="flex justify-between border-t border-gray-600 pt-2 font-bold">
                    <span style={{ color: THEME_COLORS.text }}>Points Earned:</span> 
                    <span style={{ color: THEME_COLORS.accent }}>+{quizResults.points}</span>
                </p>
                <p className="flex justify-between">
                    <span style={{ color: THEME_COLORS.hint }}>Accuracy:</span> 
                    <span style={{ color: THEME_COLORS.text }}>{quizResults.accuracy}%</span>
                </p>
            </div>
            <button
                className={appStyles.button + " mt-6"}
                style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}
                onClick={() => setQuizResults(null)}
            >
                Continue to Home
            </button>
        </div>
    );

    const QuizQuestionView = () => (
        <div className={appStyles.container} style={{ backgroundColor: THEME_COLORS.bg }}>
            <div className='flex justify-between items-center mb-4'>
                <h1 className="text-xl font-bold" style={{ color: THEME_COLORS.text }}>
                    Q: {quizCurrentQuestion + 1} / {MOCK_QUESTIONS.length}
                </h1>
                <div className="flex items-center p-2 rounded-full" style={{ backgroundColor: THEME_COLORS.cardBg, color: THEME_COLORS.accent }}>
                    <Clock size={16} className="mr-1" />
                    <span className="font-mono text-lg">{String(quizTimeLeft).padStart(2, '0')}s</span>
                </div>
            </div>

            <div style={{ ...appStyles.card, backgroundColor: THEME_COLORS.cardBg }}>
                <p className="text-lg font-semibold" style={{ color: THEME_COLORS.text }}>
                    {MOCK_QUESTIONS[quizCurrentQuestion].text}
                </p>
            </div>

            <div className="space-y-3">
                {MOCK_QUESTIONS[quizCurrentQuestion].options.map((option, index) => {
                    const optionLetter = String.fromCharCode(65 + index); // A, B, C, D
                    let optionStyle = { backgroundColor: THEME_COLORS.cardBg, color: THEME_COLORS.text };
                    
                    if (quizFeedback) {
                        if (optionLetter === quizFeedback.correctOption) {
                            optionStyle = { backgroundColor: THEME_COLORS.success, color: THEME_COLORS.buttonText };
                        } else if (quizFeedback.status === 'wrong' && optionLetter === quizAnswers.slice(-1)[0]?.selectedOption) {
                            optionStyle = { backgroundColor: THEME_COLORS.failure, color: THEME_COLORS.buttonText };
                        }
                    }

                    return (
                        <button
                            key={optionLetter}
                            className={appStyles.button + ' flex items-center justify-between shadow-md'}
                            style={{ ...optionStyle, transition: 'background-color 0.2s' }}
                            onClick={() => !quizFeedback && handleAnswer(optionLetter)}
                            disabled={!!quizFeedback}
                        >
                            <span className="text-xl font-mono mr-3 border rounded-md px-2 py-1" style={{ borderColor: optionStyle.color }}>{optionLetter}</span>
                            <span className="flex-1 text-left">{option}</span>
                            {quizFeedback && (
                                quizFeedback.status === 'correct' && optionLetter === quizFeedback.correctOption ? (
                                    <CheckCircle size={20} className="ml-2" />
                                ) : quizFeedback.status === 'wrong' && optionLetter === quizAnswers.slice(-1)[0]?.selectedOption ? (
                                    <XCircle size={20} className="ml-2" />
                                ) : null
                            )}
                        </button>
                    );
                })}
            </div>
            
            {/* Display feedback tick/cross overlay */}
            {quizFeedback && (
                <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-70 z-50">
                    <div className="text-center p-8 rounded-full transform scale-150" 
                         style={{ color: quizFeedback.status === 'correct' ? THEME_COLORS.success : THEME_COLORS.failure }}>
                        {quizFeedback.status === 'correct' ? (
                            <CheckCircle size={100} strokeWidth={3} />
                        ) : (
                            <XCircle size={100} strokeWidth={3} />
                        )}
                    </div>
                </div>
            )}
        </div>
    );

    const HomePage = () => (
        <div>
            {/* Welcome Banner */}
            <h1 className="text-2xl font-extrabold mb-4" style={{ color: THEME_COLORS.text }}>
                Welcome, {userData?.name || webApp?.initDataUnsafe?.user?.first_name || 'Footy Fan'}!
            </h1>

            {/* Today's Quiz Section */}
            <div style={{ ...appStyles.card, backgroundColor: THEME_COLORS.cardBg, border: `3px solid ${THEME_COLORS.accent}` }}>
                <div className="flex justify-between items-center mb-3">
                    <h2 className="text-xl font-bold" style={{ color: THEME_COLORS.accent }}>Today's Quiz</h2>
                    <span className="text-xs font-mono px-2 py-1 rounded-full text-white" style={{ backgroundColor: THEME_COLORS.success }}>
                        Daily
                    </span>
                </div>
                
                {quizData ? (
                    <>
                        <p className="text-lg font-semibold mb-2" style={{ color: THEME_COLORS.text }}>{quizData.name}</p>
                        <div className="grid grid-cols-2 gap-2 text-sm" style={{ color: THEME_COLORS.hint }}>
                            <div className="flex items-center"><Zap size={16} className="mr-1" /> {quizData.totalQuestions} Questions</div>
                            <div className="flex items-center"><Clock size={16} className="mr-1" /> {quizData.timeLimitSeconds} Seconds</div>
                            <div className="flex items-center"><TrendingUp size={16} className="mr-1" /> {quizData.totalPoints} Points</div>
                            <div className="flex items-center text-xs font-mono rounded-full px-2 py-1" style={{ backgroundColor: THEME_COLORS.hint, color: THEME_COLORS.cardBg }}>
                                Expires in: {formatTime(countdown)}
                            </div>
                        </div>
                        <button
                            className={appStyles.button + " mt-4"}
                            style={{ backgroundColor: isQuizCompleted ? THEME_COLORS.hint : THEME_COLORS.accent, color: THEME_COLORS.buttonText }}
                            onClick={handleStartQuiz}
                            disabled={countdown <= 0 || isQuizCompleted}
                        >
                            {isQuizCompleted ? 'Completed' : 'Start Quiz'}
                        </button>
                    </>
                ) : (
                    <p style={{ color: THEME_COLORS.hint }}>No active quiz found. Check back tomorrow!</p>
                )}
            </div>

            {/* Score and Leaderboard Section */}
            <div style={{ ...appStyles.card, backgroundColor: THEME_COLORS.cardBg }}>
                <div className="flex justify-between items-center mb-2">
                    <h2 className="text-xl font-bold" style={{ color: THEME_COLORS.text }}>Overall IQ Score</h2>
                    <span className="text-3xl font-extrabold" style={{ color: THEME_COLORS.accent }}>
                        {userData?.score?.toLocaleString() || 0}
                    </span>
                </div>

                <div className="flex justify-between items-center border-t border-gray-700 pt-3">
                    <p className="text-sm" style={{ color: THEME_COLORS.hint }}>Global Rank</p>
                    <div className="flex items-center">
                        <span className="text-xl font-bold mr-2" style={{ color: THEME_COLORS.text }}>
                            #{userData?.globalRank || 'N/A'} / 250,999 players
                        </span>
                        <button 
                            className="text-xs px-2 py-1 rounded-full" 
                            style={{ backgroundColor: THEME_COLORS.hint, color: THEME_COLORS.cardBg }}
                            onClick={() => setActivePage('Tournaments')} // Placeholder for Leaderboard view
                        >
                            View Leaderboard
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );

    const LeaguePage = () => (
        <div>
            <div className="flex space-x-2 mb-4">
                <button 
                    className={appStyles.button}
                    style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText, width: '50%' }}
                    onClick={() => handleOpenModal('create')}
                >
                    <Plus size={18} className="inline mr-1" /> Create League
                </button>
                <button 
                    className={appStyles.button}
                    style={{ backgroundColor: THEME_COLORS.success, color: THEME_COLORS.buttonText, width: '50%' }}
                    onClick={() => handleOpenModal('join')}
                >
                    <LogIn size={18} className="inline mr-1" /> Join League
                </button>
            </div>

            <h2 className="text-xl font-bold mb-3" style={{ color: THEME_COLORS.text }}>My Leagues</h2>
            {leagues.map(league => {
                return ( // The explicit return is critical for map functions returning JSX!
                    <div key={league.id} style={{ ...appStyles.card, backgroundColor: THEME_COLORS.cardBg }}>
                        <div className="flex justify-between items-start">
                            <div className="flex-1">
                                <div className="flex items-center mb-1">
                                    <h3 className="text-lg font-bold mr-2" style={{ color: THEME_COLORS.text }}>{league.name}</h3>
                                    {league.isOwner && (
                                        <span className="text-xs px-2 py-0.5 rounded-full font-semibold" 
                                            style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}>
                                            OWNER
                                        </span>
                                    )}
                                </div>
                                <p className="text-sm mb-2" style={{ color: THEME_COLORS.hint }}>{league.description}</p>
                                
                                <div className="grid grid-cols-3 gap-1 text-xs" style={{ color: THEME_COLORS.hint }}>
                                    <div className="flex items-center"><BarChart2 size={14} className="mr-1" /> Rank: #{league.rank}</div>
                                    <div className="flex items-center"><Zap size={14} className="mr-1" /> Points: {league.points.toLocaleString()}</div>
                                    <div className="flex items-center"><Users size={14} className="mr-1" /> Members: {league.members.toLocaleString()}</div>
                                </div>
                            </div>
                            <button 
                                className="text-sm py-1 px-3 rounded-xl font-semibold whitespace-nowrap ml-2" 
                                style={{ backgroundColor: THEME_COLORS.hint, color: THEME_COLORS.cardBg }}
                                onClick={() => alert(`Redirecting to league details for ${league.name}`)}
                            >
                                View League
                            </button>
                        </div>
                    </div>
                );
            })}

            <div className="mt-6">
                <div style={{ ...appStyles.input, borderColor: THEME_COLORS.hint, backgroundColor: THEME_COLORS.cardBg, color: THEME_COLORS.text }} className="flex items-center">
                    <Search size={18} className="inline mr-2" style={{ color: THEME_COLORS.hint }} />
                    <input type="text" placeholder="Search public leagues..." className="bg-transparent focus:outline-none flex-1" style={{ color: THEME_COLORS.text }} />
                </div>
            </div>
            
            <h2 className="text-xl font-bold mt-6 mb-3" style={{ color: THEME_COLORS.text }}>Popular Public Leagues</h2>
            {DEFAULT_LEAGUES.slice(0, 3).map(league => {
                return ( // The explicit return is critical for map functions returning JSX!
                    <div key={`pop-${league.id}`} style={{ ...appStyles.card, backgroundColor: THEME_COLORS.cardBg }}>
                        <div className="flex justify-between items-center">
                             <div>
                                <h3 className="text-lg font-bold" style={{ color: THEME_COLORS.text }}>{league.name}</h3>
                                <p className="text-xs" style={{ color: THEME_COLORS.hint }}>{league.description.slice(0, 30)}...</p>
                                <p className="text-xs mt-1" style={{ color: THEME_COLORS.hint }}>
                                    Members: {league.members.toLocaleString()} | Starts in: 7d 12h
                                </p>
                            </div>
                             <button 
                                className="text-sm py-2 px-4 rounded-xl font-semibold whitespace-nowrap ml-2" 
                                style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}
                                onClick={() => alert(`Joining ${league.name}`)}
                            >
                                Join League
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    const TournamentPage = () => (
        <div className="text-center pt-16">
            <Shield size={64} className="mx-auto mb-4" style={{ color: THEME_COLORS.accent }} />
            <div style={{ ...appStyles.card, backgroundColor: THEME_COLORS.cardBg, border: `2px dashed ${THEME_COLORS.accent}` }}>
                <h2 className="text-2xl font-extrabold mb-2" style={{ color: THEME_COLORS.text }}>Weekly Global Tournaments</h2>
                <p className="text-lg font-semibold mb-4" style={{ color: THEME_COLORS.hint }}>Earn cash rewards by competing for the top spot!</p>
                <div className="inline-block px-4 py-2 rounded-full font-bold text-lg" style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}>
                    COMING SOON...
                </div>
            </div>
        </div>
    );

    const ProfilePage = () => (
        <div>
            {/* User Profile Section */}
            <div className="flex items-center justify-between mb-8" style={{ ...appStyles.card, backgroundColor: THEME_COLORS.cardBg }}>
                <div className="flex items-center">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center text-4xl font-bold mr-4" style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}>
                        {userData?.name ? userData.name[0] : 'P'}
                    </div>
                    <div>
                        <h2 className="text-xl font-bold" style={{ color: THEME_COLORS.text }}>{userData?.name || 'Loading Name...'}</h2>
                        <p className="text-sm" style={{ color: THEME_COLORS.hint }}>@{webApp?.initDataUnsafe?.user?.username || 'no_username'}</p>
                        <p className="text-xs mt-1" style={{ color: THEME_COLORS.hint }}>User ID: **{userId || 'N/A'}**</p>
                    </div>
                </div>
                 <button 
                    className="p-2 rounded-full transition-colors transform active:scale-95" 
                    style={{ backgroundColor: THEME_COLORS.failure, color: THEME_COLORS.buttonText }}
                    onClick={handleSignOut}
                >
                    <LogOut size={20} />
                </button>
            </div>

            {/* Tasks Section */}
            <h2 className="text-xl font-bold mb-3" style={{ color: THEME_COLORS.text }}>Today's Tasks</h2>
            <div className="space-y-3">
                {DAILY_TASKS.map((task, index) => {
                    return ( // The explicit return is critical for map functions returning JSX!
                        <div key={index} className="flex justify-between items-center p-4 rounded-xl shadow-md" style={{ backgroundColor: THEME_COLORS.cardBg }}>
                            <div className="flex-1">
                                <p className="font-semibold" style={{ color: THEME_COLORS.text }}>{task.name}</p>
                                <p className="text-sm font-bold mt-1" style={{ color: THEME_COLORS.success }}>+{task.points.toLocaleString()} points</p>
                            </div>
                            <a 
                                href={task.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm py-2 px-4 rounded-xl font-bold whitespace-nowrap ml-4 transition-transform transform active:scale-95" 
                                style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}
                            >
                                {task.action}
                            </a>
                        </div>
                    );
                })}
            </div>
        </div>
    );
    
    const LeagueModal = () => {
        const isCreate = modalType === 'create';
        
        return (
            <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center p-4 z-50" onClick={() => setIsModalOpen(false)}>
                <div 
                    className="w-full max-w-md p-6 rounded-xl shadow-2xl" 
                    style={{ backgroundColor: THEME_COLORS.cardBg, color: THEME_COLORS.text }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <h2 className="text-2xl font-extrabold mb-4" style={{ color: THEME_COLORS.accent }}>
                        {isCreate ? 'Create New League' : 'Join League'}
                    </h2>
                    
                    {isCreate ? (
                        <>
                            <input 
                                type="text" 
                                placeholder="League Name" 
                                value={leagueFormData.name}
                                onChange={(e) => setLeagueFormData({ ...leagueFormData, name: e.target.value })}
                                className={appStyles.input}
                                style={{ borderColor: THEME_COLORS.hint, backgroundColor: THEME_COLORS.bg, color: THEME_COLORS.text }}
                            />
                            <textarea 
                                placeholder="Description" 
                                value={leagueFormData.description}
                                onChange={(e) => setLeagueFormData({ ...leagueFormData, description: e.target.value })}
                                className={appStyles.input}
                                style={{ borderColor: THEME_COLORS.hint, backgroundColor: THEME_COLORS.bg, resize: 'none', color: THEME_COLORS.text }}
                            />
                            <div className="flex items-center mb-4">
                                <input 
                                    type="checkbox" 
                                    id="privateCheck" 
                                    checked={leagueFormData.isPrivate}
                                    onChange={(e) => setLeagueFormData({ ...leagueFormData, isPrivate: e.target.checked })}
                                    className="mr-2 h-4 w-4 rounded"
                                    style={{ backgroundColor: THEME_COLORS.accent, borderColor: THEME_COLORS.accent }}
                                />
                                <label htmlFor="privateCheck" className="text-sm" style={{ color: THEME_COLORS.hint }}>
                                    This league is a private league (requires 6-digit code)
                                </label>
                            </div>
                        </>
                    ) : (
                        <input 
                            type="text" 
                            placeholder="Enter 6-digit Alpha-Numeric Code" 
                            value={leagueFormData.code}
                            onChange={(e) => setLeagueFormData({ ...leagueFormData, code: e.target.value.toUpperCase() })}
                            maxLength={6}
                            className={appStyles.input + " font-mono text-center tracking-widest"}
                            style={{ borderColor: THEME_COLORS.hint, backgroundColor: THEME_COLORS.bg, color: THEME_COLORS.text }}
                        />
                    )}

                    <button
                        className={appStyles.button + " mt-2"}
                        style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}
                        onClick={handleModalSubmit}
                        disabled={isLoading}
                    >
                        {isLoading ? 'Processing...' : (isCreate ? 'Create League' : 'Join League')}
                    </button>
                    <button
                        className={appStyles.button + " mt-2"}
                        style={{ backgroundColor: THEME_COLORS.hint, color: THEME_COLORS.buttonText }}
                        onClick={() => setIsModalOpen(false)}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    };


    // --- MAIN RENDER ---

    if (!isAuthReady) {
        return (
            <div className="fixed inset-0 flex flex-col items-center justify-center p-6" style={{ backgroundColor: THEME_COLORS.bg, color: THEME_COLORS.text }}>
                <div className="animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: THEME_COLORS.accent }}></div>
                <p className="mt-4 text-sm" style={{ color: THEME_COLORS.hint }}>Securing connection via Telegram...</p>
                {error && <p className="mt-4 text-red-500 text-sm font-bold">{error}</p>}
                {(!auth || !webApp) && (
                     <p className="mt-2 text-yellow-400 text-xs text-center">
                        Warning: Firebase or Telegram SDK may not be fully available in this environment. Functionality will be limited.
                     </p>
                )}
            </div>
        );
    }
    
    if (isQuizActive) {
        return <QuizQuestionView />;
    }

    // Modal overlay for quiz results
    if (quizResults) {
        return (
            <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ backgroundColor: `${THEME_COLORS.bg}d0` }}>
                <QuizResultsModal />
            </div>
        );
    }

    const renderPage = () => {
        if (!userId) {
            return (
                <div className="text-center pt-16">
                    <Lock size={64} className="mx-auto mb-4" style={{ color: THEME_COLORS.hint }} />
                    <h2 className="text-2xl font-extrabold mb-2" style={{ color: THEME_COLORS.text }}>Authentication Required</h2>
                    <p className="text-lg font-semibold mb-4" style={{ color: THEME_COLORS.hint }}>
                        Please ensure you launched this app from a secure Telegram Mini App context.
                    </p>
                    <button
                        className={appStyles.button + " mt-4"}
                        style={{ backgroundColor: THEME_COLORS.accent, color: THEME_COLORS.buttonText }}
                        onClick={() => handleSecureAuth()}
                        disabled={isLoading}
                    >
                        Retry Authentication
                    </button>
                </div>
            );
        }

        switch (activePage) {
            case 'Home':
                return <HomePage />;
            case 'League':
                return <LeaguePage />;
            case 'Tournaments':
                return <TournamentPage />;
            case 'Profile':
                return <ProfilePage />;
            default:
                return <HomePage />;
        }
    };

    return (
        <div style={{ backgroundColor: THEME_COLORS.bg }} className={appStyles.container}>
            
            {isModalOpen && <LeagueModal />}
            
            <main>
                {renderPage()}
            </main>

            {/* Fixed Bottom Navigation */}
            <nav className="fixed bottom-0 left-0 right-0 shadow-2xl p-2 z-40" 
                 style={{ backgroundColor: THEME_COLORS.cardBg, borderTop: `1px solid ${THEME_COLORS.hint}20` }}>
                <div className="flex justify-around items-center max-w-xl mx-auto">
                    {['Home', 'League', 'Tournaments', 'Profile'].map((page) => (
                        <button 
                            key={page}
                            onClick={() => setActivePage(page)}
                            className={`flex flex-col items-center p-2 rounded-lg transition-colors`}
                            style={{ color: activePage === page ? THEME_COLORS.accent : THEME_COLORS.hint }}
                        >
                            {page === 'Home' && <Home className={appStyles.navIcon} />}
                            {page === 'League' && <Shield className={appStyles.navIcon} />}
                            {page === 'Tournaments' && <Zap className={appStyles.navIcon} />}
                            {page === 'Profile' && <User className={appStyles.navIcon} />}
                            <span className="text-xs mt-1">{page}</span>
                        </button>
                    ))}
                </div>
            </nav>
        </div>
    );
};

export default App;
