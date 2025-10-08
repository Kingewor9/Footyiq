import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Home, Trophy, Users, User, Clock, CheckCircle, XCircle, ChevronRight, Search, Plus, Zap, Star } from 'lucide-react';

// --- Firebase Imports (Required for real-time scores and leagues) ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, collection, query, setDoc, getDocs, runTransaction, where, limit, addDoc } from 'firebase/firestore';
import { setLogLevel } from 'firebase/firestore';

// Set Firebase log level (optional, but good for debugging)
setLogLevel('debug');

// --- Global Variable Access & Setup ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-footy-iq-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : { projectId: 'footy-iq-dev' };
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Simulated Quiz Data
const QUIZ_DATA = {
    id: 'quiz-20251008',
    name: "Classic Football Legends Trivia",
    totalQuestions: 25,
    timeLimitSeconds: 90,
    pointsPerQuestion: 10,
    totalPoints: 250,
    expiresAt: Date.now() + (24 * 60 * 60 * 1000), // Expires 24 hours from now
    questions: [
        { id: 1, text: "Which player has won the most Ballon d'Or awards?", options: ["Lionel Messi", "Cristiano Ronaldo", "Michel Platini", "Johan Cruyff"], correct: "Lionel Messi" },
        { id: 2, text: "Which nation won the FIFA World Cup in 2014?", options: ["Brazil", "Argentina", "Germany", "Spain"], correct: "Germany" },
        { id: 3, text: "What club holds the record for the most Champions League titles?", options: ["FC Barcelona", "AC Milan", "Real Madrid", "Bayern Munich"], correct: "Real Madrid" },
        // Add one more for testing completion
        { id: 4, text: "Who is the all-time top scorer for the English Premier League?", options: ["Alan Shearer", "Wayne Rooney", "Thierry Henry", "Sergio Agüero"], correct: "Alan Shearer" },
    ]
};

// Simulated League Data
const DEFAULT_LEAGUES = [
    { id: 'L1', name: 'Global Pro League', description: 'The worldwide ultimate football quiz challenge.', ownerId: 'system', rank: 4, points: 12000, members: 2400, isPrivate: false, startDate: Date.now() - (7 * 24 * 60 * 60 * 1000) },
    { id: 'L2', name: 'Weekend Warriors', description: 'A casual league for weekend quizzers.', ownerId: 'user123', rank: 1, points: 5000, members: 15, isPrivate: true, isOwner: true, startDate: Date.now() - (3 * 24 * 60 * 60 * 1000) },
    { id: 'L3', name: 'PL Fanatics', description: 'Premier League only trivia.', ownerId: 'system', rank: 12, points: 8000, members: 890, isPrivate: false, startDate: Date.now() - (10 * 24 * 60 * 60 * 1000) },
];

// Simulated Tasks Data
const DAILY_TASKS = [
    { name: "Join us on Telegram", points: 100, action: "Join", url: "https://t.me/footyiq" },
    { name: "Invite 5 friends to join the game", points: 1000, action: "Invite", url: "#" },
    { name: "Watch this free ad (30s)", points: 500, action: "Go", url: "#" },
];

/**
 * Utility function to simulate Telegram Haptic Feedback.
 */
const Haptics = {
    // Note: We use the browser's native vibration API for simulation.
    success: () => navigator.vibrate && navigator.vibrate(50), 
    error: () => navigator.vibrate && navigator.vibrate([100, 50, 100]), 
    light: () => navigator.vibrate && navigator.vibrate(10),
};

// --- TMA Theme Colors (Simulation) ---
// In a real TMA, these colors come from window.Telegram.WebApp.themeParams
const THEME_COLORS = {
    dark: {
        bg_color: '#182533', // Telegram Dark BG
        secondary_bg_color: '#213040', // Telegram Card/Secondary BG
        text_color: '#FFFFFF',
        hint_color: '#8C9EA7',
        link_color: '#4AC7F2',
        button_color: '#3390EC',
        button_text_color: '#FFFFFF',
        destructive_color: '#FF6F6F',
    },
    light: {
        bg_color: '#F0F0F0',
        secondary_bg_color: '#FFFFFF',
        text_color: '#000000',
        hint_color: '#8A8A8A',
        link_color: '#007AFF',
        button_color: '#007AFF',
        button_text_color: '#FFFFFF',
        destructive_color: '#FF3B30',
    }
};


// --- Core App Component ---
const App = () => {
    // --- Authentication and Data State ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    
    // Theme State
    const [theme, setTheme] = useState(THEME_COLORS.dark); // Default to dark mode
    const [activePage, setActivePage] = useState('Home');
    
    // Game Data State (Fetched from Firestore/Simulated)
    const [userData, setUserData] = useState({
        name: 'Guest Player',
        username: 'loading_user',
        avatarUrl: `https://placehold.co/100x100/3390EC/FFFFFF?text=TG`,
        score: 0,
        globalRank: '#N/A',
        totalPlayers: '...',
        leagueScore: 0,
    });
    
    const [isQuizActive, setIsQuizActive] = useState(false);
    const [quizState, setQuizState] = useState(null); // Used during the quiz
    const [quizResult, setQuizResult] = useState(null); // Used after quiz submission
    const [timeRemaining, setTimeRemaining] = useState(QUIZ_DATA.timeLimitSeconds);
    const [showModal, setShowModal] = useState(null); // 'CreateLeague', 'JoinLeague', 'Leaderboard', 'Results'

    // --- Firebase Initialization and Auth Effect ---
    useEffect(() => {
        // Only run once on component mount
        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authInstance = getAuth(app);

            setDb(firestore);
            setAuth(authInstance);

            const unsubscribe = onAuthStateChanged(authInstance, (user) => {
                const uid = user?.uid || crypto.randomUUID();
                setUserId(uid);

                // --- Simulate Telegram WebApp User Data ---
                // In a real TMA, user.first_name, user.username come from initData
                const simulatedName = initialAuthToken ? `Telegram User ${uid.substring(0, 4)}` : 'Anonymous Player';
                const simulatedUsername = `tg_${uid.substring(0, 8)}`;

                // Set initial user data
                setUserData(prev => ({
                    ...prev,
                    name: simulatedName,
                    username: simulatedUsername,
                    avatarUrl: `https://placehold.co/100x100/${theme.button_color.replace('#', '')}/${theme.button_text_color.replace('#', '')}?text=${simulatedName.substring(0, 1)}`,
                }));
                
                setIsAuthReady(true);
            });

            // Handle initial token sign-in
            if (initialAuthToken) {
                signInWithCustomToken(authInstance, initialAuthToken).catch(e => {
                    console.error("Custom token sign-in failed, signing in anonymously.", e);
                    signInAnonymously(authInstance);
                });
            } else {
                signInAnonymously(authInstance);
            }
            
            return () => unsubscribe();
        } catch (e) {
            console.error("Firebase Initialization Error:", e);
        }
    }, [initialAuthToken, theme.button_color, theme.button_text_color]);

    // --- Firestore Data Listener Effect ---
    useEffect(() => {
        if (!db || !userId || !isAuthReady) return;

        // 1. Listen to User Data (Private Data)
        const userDocRef = doc(db, `artifacts/${appId}/users/${userId}/gameData`, 'profile');
        const unsubscribeUser = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setUserData(prev => ({
                    ...prev,
                    score: data.score || 0,
                    leagueScore: data.leagueScore || 0,
                    globalRank: data.globalRank || '#N/A', // Assuming rank calculation happens on backend
                    totalPlayers: data.totalPlayers || '...'
                }));
            } else {
                // Initialize user profile on first run
                const initialData = { score: 0, leagueScore: 0, globalRank: '#N/A', totalPlayers: '250,999' };
                setDoc(userDocRef, initialData, { merge: true }).catch(e => console.error("Error initializing user data:", e));
                setUserData(prev => ({ ...prev, ...initialData }));
            }
        });

        // 2. Listen to Global Leaderboard Rank (Simulated public data fetch)
        const globalRankRef = doc(db, `artifacts/${appId}/public/data/leaderboard`, 'global_stats');
        const unsubscribeRank = onSnapshot(globalRankRef, (docSnap) => {
            if (docSnap.exists()) {
                const { totalPlayers = '250,999' } = docSnap.data();
                setUserData(prev => ({ ...prev, totalPlayers }));
            } else {
                setDoc(globalRankRef, { totalPlayers: 250999 }, { merge: true }).catch(e => console.error("Error setting global stats:", e));
            }
        });
        
        return () => {
            unsubscribeUser();
            unsubscribeRank();
        };
    }, [db, userId, isAuthReady]);

    // --- Timer Effect for Quiz ---
    useEffect(() => {
        if (!isQuizActive) return;

        const timer = setInterval(() => {
            setTimeRemaining(prevTime => {
                if (prevTime <= 1) {
                    clearInterval(timer);
                    endQuiz(true); // End due to time limit
                    return 0;
                }
                return prevTime - 1;
            });
        }, 1000);

        return () => clearInterval(timer);
    }, [isQuizActive]);


    // --- Quiz Logic ---
    const startQuiz = () => {
        Haptics.light();
        setIsQuizActive(true);
        setQuizResult(null);
        setTimeRemaining(QUIZ_DATA.timeLimitSeconds);
        setQuizState({
            currentQuestionIndex: 0,
            correctAnswers: 0,
            answeredCount: 0,
            questionStatus: {} // { qId: 'correct' | 'incorrect' | 'unanswered', selected: 'Option' }
        });
    };
    
    const endQuiz = (timedOut = false) => {
        setIsQuizActive(false);
        const finalResults = calculateResults(quizState, timedOut);
        setQuizResult(finalResults);
        
        // Save score to Firestore
        if (db && userId) {
            updateUserScore(finalResults.pointsEarned);
        }
        
        // Show results modal
        setShowModal('Results');
        Haptics.success();
    };

    const calculateResults = (state) => {
        const totalAnswered = state.answeredCount;
        const correctAnswers = state.correctAnswers;
        const pointsEarned = correctAnswers * QUIZ_DATA.pointsPerQuestion;
        const accuracyRate = totalAnswered > 0 ? (correctAnswers / totalAnswered) * 100 : 0;
        
        return {
            totalAnswered,
            correctAnswers,
            pointsEarned,
            accuracyRate: accuracyRate.toFixed(1),
        };
    };

    const handleAnswer = (selectedOption) => {
        if (!quizState || quizState.questionStatus[QUIZ_DATA.questions[quizState.currentQuestionIndex].id]) return; // Already answered

        const currentQ = QUIZ_DATA.questions[quizState.currentQuestionIndex];
        const isCorrect = selectedOption === currentQ.correct;
        
        Haptics[isCorrect ? 'success' : 'error']();

        const newStatus = {
            ...quizState.questionStatus,
            [currentQ.id]: {
                status: isCorrect ? 'correct' : 'incorrect',
                selected: selectedOption,
                correctAnswer: currentQ.correct,
            }
        };

        const newCorrectCount = isCorrect ? quizState.correctAnswers + 1 : quizState.correctAnswers;
        const newAnsweredCount = quizState.answeredCount + 1;

        setQuizState({
            ...quizState,
            correctAnswers: newCorrectCount,
            answeredCount: newAnsweredCount,
            questionStatus: newStatus,
        });

        // Move to next question after a brief delay
        setTimeout(() => {
            const nextIndex = quizState.currentQuestionIndex + 1;
            if (nextIndex < QUIZ_DATA.questions.length) { // Use actual length of questions array
                setQuizState(prev => ({ ...prev, currentQuestionIndex: nextIndex }));
            } else {
                endQuiz();
            }
        }, 800);
    };
    
    const updateUserScore = useCallback(async (points) => {
        if (!db || !userId) return;
        const userDocRef = doc(db, `artifacts/${appId}/users/${userId}/gameData`, 'profile');

        try {
            await runTransaction(db, async (transaction) => {
                const docSnap = await transaction.get(userDocRef);
                const currentScore = docSnap.exists() ? docSnap.data().score || 0 : 0;
                const newScore = currentScore + points;
                
                transaction.set(userDocRef, { score: newScore, leagueScore: newScore, globalRank: '#calculating' }, { merge: true });
                setUserData(prev => ({ ...prev, score: newScore, leagueScore: newScore, globalRank: '#calculating' })); // Optimistic update
            });
            Haptics.light();
            console.log("Score successfully updated.");
        } catch (e) {
            console.error("Score update failed:", e);
            Haptics.error();
        }
    }, [db, userId]);


    // --- Modal Logic ---
    const handleCreateLeague = async (e) => {
        e.preventDefault();
        Haptics.light();
        if (!db || !userId) {
            showToast("Authentication not ready. Please try again.", 'error');
            return;
        }

        const form = e.target;
        const name = form.name.value;
        const description = form.description.value;
        const isPrivate = form.isPrivate.checked;

        const leagueData = {
            name,
            description,
            isPrivate,
            ownerId: userId,
            ownerName: userData.name,
            createdAt: Date.now(),
            members: 1,
            points: 0,
            code: isPrivate ? Math.random().toString(36).substring(2, 8).toUpperCase() : null,
            startDate: Date.now()
        };

        try {
            const leaguesColRef = collection(db, `artifacts/${appId}/public/data/leagues`);
            await addDoc(leaguesColRef, leagueData);
            showToast("League created successfully!");
            setShowModal(null);
            // After creation, the user is conceptually redirected to the league details.
        } catch (e) {
            console.error("Error creating league:", e);
            showToast("Failed to create league.", 'error');
        }
    };

    const handleJoinLeague = async (e) => {
        e.preventDefault();
        Haptics.light();
        if (!db || !userId) {
            showToast("Authentication not ready. Please try again.", 'error');
            return;
        }

        const code = e.target.code.value.toUpperCase();
        if (!code) return showToast("Please enter a 6-digit code.", 'error');

        try {
            const leaguesColRef = collection(db, `artifacts/${appId}/public/data/leagues`);
            const q = query(leaguesColRef, where("code", "==", code), limit(1));

            const querySnapshot = await getDocs(q);
            if (querySnapshot.empty) {
                return showToast("League not found. Check the code.", 'error');
            }

            const leagueDoc = querySnapshot.docs[0];
            const league = { ...leagueDoc.data(), id: leagueDoc.id };

            // Use custom modal for confirmation (avoiding window.confirm)
            setShowModal({
                type: 'ConfirmJoin',
                league,
            });
        } catch (e) {
            console.error("Error joining league:", e);
            showToast("An error occurred while searching for the league.", 'error');
        }
    };

    const confirmJoinLeague = async (leagueId) => {
        setShowModal(null); // Close confirmation modal
        
        // In a real app, this would involve updating the league document with the new member.
        showToast(`Successfully joined league! (Simulated)`);
        
        // Simulate adding the league to the user's list (for display purposes)
        // In reality, this would be derived from the league's member list
        // DEFAULT_LEAGUES.push({ id: leagueId, name: 'New Joined League', description: 'Joined via code', ownerId: 'other', rank: 99, points: 10, members: 2, isPrivate: true });
        
    }
    
    // Simple Toast/Message Box (since alert/confirm are forbidden)
    const showToast = (message, type = 'success') => {
        let toast = document.getElementById('app-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'app-toast';
            toast.className = 'fixed top-4 left-1/2 -translate-x-1/2 p-3 rounded-xl shadow-xl transition-all duration-300 opacity-0 z-50 text-sm font-semibold';
            document.body.appendChild(toast);
        }
        
        toast.textContent = message;
        toast.className = toast.className.replace(/bg-[\w-]+/g, '') + ' ' + (type === 'error' ? 'bg-red-500 text-white' : 'bg-green-500 text-white');
        toast.classList.remove('opacity-0');
        toast.classList.add('opacity-100');

        setTimeout(() => {
            toast.classList.remove('opacity-100');
            toast.classList.add('opacity-0');
        }, 3000);
    };
    
    // --- Styles Memo for Theme Application ---
    const appStyles = useMemo(() => ({
        body: { backgroundColor: theme.bg_color, color: theme.text_color, transition: 'background-color 0.3s' },
        card: { backgroundColor: theme.secondary_bg_color, transition: 'background-color 0.3s', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)' },
        button: { backgroundColor: theme.button_color, color: theme.button_text_color, transition: 'background-color 0.3s' },
        link: { color: theme.link_color, transition: 'color 0.3s' },
        hint: { color: theme.hint_color, transition: 'color 0.3s' },
    }), [theme]);
    
    // --- Shared Components ---

    const QuizCountdown = ({ time }) => {
        const minutes = Math.floor(time / 60);
        const seconds = time % 60;
        const color = time <= 10 ? 'text-red-500 animate-pulse' : appStyles.hint.color;

        return (
            <div className="flex items-center space-x-1 text-sm font-medium" style={{ color }}>
                <Clock size={16} />
                <span className="tabular-nums">{minutes.toString().padStart(2, '0')}:{seconds.toString().padStart(2, '0')}</span>
            </div>
        );
    };

    const NavigationBar = () => {
        const navItems = [
            { name: 'Home', icon: Home },
            { name: 'League', icon: Trophy },
            { name: 'Tournaments', icon: Zap },
            { name: 'Profile', icon: User },
        ];

        return (
            <div id="nav-bar" style={{ backgroundColor: theme.secondary_bg_color, borderTop: `1px solid ${theme.hint_color}30` }}
                 className="fixed bottom-0 left-0 right-0 h-16 flex justify-around shadow-2xl z-40 transition duration-300">
                {navItems.map((item) => {
                    const isActive = activePage === item.name;
                    return (
                        <button 
                            key={item.name}
                            onClick={() => { setActivePage(item.name); Haptics.light(); }}
                            className={`flex flex-col items-center justify-center text-xs font-medium px-2 py-1 transition-colors duration-200 ${isActive ? 'scale-105' : ''}`}
                            style={{ color: isActive ? theme.link_color : theme.hint_color }}
                        >
                            <item.icon size={24} strokeWidth={isActive ? 2.5 : 2} />
                            <span className="mt-0.5">{item.name}</span>
                        </button>
                    );
                })}
            </div>
        );
    };

    const Modal = ({ title, children, onClose, customClass = "" }) => (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div 
                className={`w-full max-w-sm rounded-xl p-6 shadow-2xl transition-all duration-300 transform scale-100 ${customClass}`} 
                style={appStyles.card}
                onClick={e => e.stopPropagation()} // Prevent closing when clicking inside
            >
                <div className="flex justify-between items-center mb-4 border-b pb-2" style={{ borderColor: theme.hint_color + '40' }}>
                    <h2 className="text-xl font-bold">{title}</h2>
                    <button onClick={onClose} style={appStyles.hint} className="hover:opacity-70 transition">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
    
    // --- Page Implementations ---
    
    const HomePage = () => {
        // Countdown for the main quiz block
        const quizExpiration = QUIZ_DATA.expiresAt;
        const [timeUntilExpiry, setTimeUntilExpiry] = useState(Math.max(0, Math.floor((quizExpiration - Date.now()) / 1000)));

        useEffect(() => {
            if (timeUntilExpiry <= 0) return;
            const interval = setInterval(() => {
                setTimeUntilExpiry(prevTime => {
                    if (prevTime <= 1) {
                        clearInterval(interval);
                        return 0;
                    }
                    return prevTime - 1;
                });
            }, 1000);
            return () => clearInterval(interval);
        }, [timeUntilExpiry]);
        
        const isQuizExpired = timeUntilExpiry <= 0;
        
        const formatTime = (seconds) => {
            const days = Math.floor(seconds / (3600 * 24));
            const hours = Math.floor((seconds % (3600 * 24)) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            
            if (days > 0) return `${days}d ${hours}h`;
            if (hours > 0) return `${hours}h ${minutes}m`;
            return `${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
        };
        
        // Render current quiz if active
        if (isQuizActive && quizState) {
            const currentQ = QUIZ_DATA.questions[quizState.currentQuestionIndex];
            const qStatus = quizState.questionStatus[currentQ.id];
            
            return (
                <div className="flex flex-col h-full p-4 space-y-4" style={appStyles.body}>
                    <div className="flex justify-between items-center">
                        <span className="text-sm font-semibold" style={appStyles.hint}>
                            Question {quizState.currentQuestionIndex + 1} of {QUIZ_DATA.questions.length}
                        </span>
                        <QuizCountdown time={timeRemaining} />
                    </div>
                    
                    <div className="flex-grow flex flex-col justify-center items-center text-center">
                        <Star size={32} className="mb-4" style={appStyles.link} />
                        <p className="text-2xl font-bold mb-8">{currentQ.text}</p>
                    </div>
                    
                    <div className="space-y-3 pb-4">
                        {currentQ.options.map((option) => {
                            const isSelected = qStatus && qStatus.selected === option;
                            const isCorrect = qStatus && qStatus.correctAnswer === option;
                            
                            let optionClass = 'border-2';
                            let optionStyle = { borderColor: theme.hint_color + '40', ...appStyles.card }; // Combine styles properly
                            
                            if (qStatus) {
                                if (isCorrect) {
                                    optionClass = 'border-green-500 bg-green-500/20';
                                    optionStyle = { ...optionStyle, backgroundColor: '#10B98120' };
                                } else if (isSelected) {
                                    optionClass = 'border-red-500 bg-red-500/20';
                                    optionStyle = { ...optionStyle, backgroundColor: '#EF444420' };
                                } else {
                                    optionClass = 'border-transparent opacity-50';
                                    optionStyle = appStyles.card;
                                }
                            }

                            return (
                                <button
                                    key={option}
                                    onClick={() => !qStatus && handleAnswer(option)}
                                    className={`w-full py-3 px-4 rounded-xl text-left font-medium flex items-center justify-between transition duration-200 ${optionClass}`}
                                    style={{ ...optionStyle, pointerEvents: qStatus ? 'none' : 'auto' }}
                                >
                                    <span>{option}</span>
                                    {qStatus && (
                                        isCorrect ? <CheckCircle size={20} className="text-green-500" /> : 
                                        isSelected ? <XCircle size={20} className="text-red-500" /> : null
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            );
        }
        
        // Render Home page content
        return (
            <div className="space-y-6 p-4">
                {/* Welcome Header */}
                <p className="text-xl font-bold">Welcome, {userData.name}!</p>

                {/* Today's Quiz Card (Top of Home Page) */}
                <div className="rounded-xl p-4 shadow-lg border border-yellow-500/50" style={appStyles.card}>
                    <h2 className="text-lg font-bold mb-3 flex justify-between items-center">
                        <span>Today's Quiz</span>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-yellow-500 text-black">DAILY</span>
                    </h2>
                    
                    <h3 className="text-xl font-semibold mb-3">{QUIZ_DATA.name}</h3>

                    <div className="grid grid-cols-2 gap-3 text-sm" style={appStyles.hint}>
                        <div className="flex items-center space-x-2"><Home size={16} /><span>{QUIZ_DATA.totalQuestions} Questions</span></div>
                        <div className="flex items-center space-x-2"><Clock size={16} /><span>{QUIZ_DATA.timeLimitSeconds} Seconds</span></div>
                        <div className="flex items-center space-x-2"><Zap size={16} /><span>{QUIZ_DATA.totalPoints} Points</span></div>
                        <div className="flex items-center space-x-2">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-timer-off"><path d="M10.14 2.14a2 2 0 0 1 3.72 0"/><path d="M12 19v-4"/><path d="M22 13a10 10 0 0 1-9.98 9.98M2 12a10 10 0 0 0 9.92 9.96"/><path d="M2 2l20 20"/></svg>
                            <span className={timeUntilExpiry <= 3600 ? 'text-red-400' : ''}>Expires in {formatTime(timeUntilExpiry)}</span>
                        </div>
                    </div>
                    
                    <button 
                        onClick={startQuiz}
                        style={appStyles.button}
                        disabled={isQuizExpired}
                        className={`w-full py-3 mt-4 rounded-xl font-semibold text-lg transition duration-200 shadow-lg ${isQuizExpired ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}`}
                    >
                        {isQuizExpired ? 'Quiz Expired' : 'Start Quiz'}
                    </button>
                </div>

                {/* Score and Leaderboard Card */}
                <div className="rounded-xl p-4 shadow-lg" style={appStyles.card}>
                    <h2 className="text-lg font-bold mb-3">Your Stats</h2>
                    
                    <div className="flex justify-between items-center mb-3">
                        <span className="text-sm font-medium" style={appStyles.hint}>Overall Score</span>
                        <span className="text-3xl font-extrabold" style={appStyles.link}>{userData.score.toLocaleString()}</span>
                    </div>

                    <div className="flex justify-between items-center mb-4">
                        <span className="text-sm font-medium" style={appStyles.hint}>Global Rank</span>
                        <div className="flex items-center text-lg font-bold">
                            <Trophy size={20} className="mr-2 text-yellow-500" />
                            {userData.globalRank.startsWith('#') ? userData.globalRank : `#${userData.globalRank}`}/{userData.totalPlayers} players
                        </div>
                    </div>
                    
                    <button 
                        onClick={() => { Haptics.light(); setShowModal('Leaderboard'); }}
                        className="w-full text-center py-2 text-sm font-semibold rounded-lg"
                        style={appStyles.link}
                    >
                        View Global Leaderboard <ChevronRight size={16} className="inline ml-1 -mt-0.5" />
                    </button>
                </div>
            </div>
        );
    };

    const LeaguePage = () => {
        const [searchQuery, setSearchQuery] = useState('');
        
        const filteredLeagues = DEFAULT_LEAGUES.filter(l => 
            !l.isOwner && (
                l.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                l.description.toLowerCase().includes(searchQuery.toLowerCase())
            )
        );
        
        const myLeagues = DEFAULT_LEAGUES.filter(l => l.ownerId === 'user123' || l.rank < 10); // Simulated "my" leagues

        return (
            <div className="p-4 space-y-6">
                
                {/* League Actions */}
                <div className="flex space-x-3">
                    <button 
                        onClick={() => { Haptics.light(); setShowModal('CreateLeague'); }} 
                        style={appStyles.button}
                        className="flex-1 py-3 rounded-xl font-semibold flex items-center justify-center shadow-md hover:opacity-90 transition"
                    >
                        <Plus size={20} className="mr-2" /> Create League
                    </button>
                    <button 
                        onClick={() => { Haptics.light(); setShowModal('JoinLeague'); }} 
                        className="flex-1 py-3 rounded-xl font-semibold border"
                        style={{ borderColor: theme.link_color, color: theme.link_color, backgroundColor: theme.secondary_bg_color }}
                    >
                        Join League
                    </button>
                </div>

                {/* My Leagues Section */}
                <div className="space-y-3">
                    <h2 className="text-xl font-bold">My Leagues ({myLeagues.length})</h2>
                    {myLeagues.map(league => (
                        <div key={league.id} className="rounded-xl p-4 shadow-lg flex justify-between items-center hover:opacity-90 transition duration-150" style={appStyles.card}>
                            <div className="flex-1 min-w-0">
                                <h3 className="font-bold text-lg flex items-center">
                                    {league.name}
                                    {league.isOwner && (
                                        <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-green-500 text-black">OWNER</span>
                                    )}
                                </h3>
                                <p className="text-sm truncate" style={appStyles.hint}>{league.description}</p>
                                <div className="mt-2 text-sm font-medium space-y-0.5">
                                    <p style={appStyles.hint}>Rank: <span className="font-semibold" style={appStyles.link}>#{league.rank}</span></p>
                                    <p style={appStyles.hint}>Points: <span className="font-semibold">{league.points.toLocaleString()}</span></p>
                                </div>
                            </div>
                            <button className="flex-shrink-0 ml-4 py-2 px-3 text-sm font-semibold rounded-lg hover:opacity-80" style={appStyles.button}>
                                View League
                            </button>
                        </div>
                    ))}
                </div>
                
                {/* League Search and Discovery */}
                <h2 className="text-xl font-bold pt-4">Discover Public Leagues</h2>
                
                {/* Search Bar */}
                <div className="relative">
                    <Search size={20} className="absolute left-3 top-1/2 transform -translate-y-1/2" style={appStyles.hint} />
                    <input
                        type="text"
                        placeholder="Search leagues by name or description..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full py-3 pl-10 pr-4 rounded-xl text-base focus:outline-none focus:ring-2"
                        style={{ ...appStyles.card, border: '1px solid ' + theme.hint_color + '40' }} // Fixed style concatenation
                    />
                </div>
                
                {/* Display Top/Searched Leagues */}
                <div className="space-y-3">
                    {(searchQuery ? filteredLeagues : DEFAULT_LEAGUES.filter(l => !l.isPrivate).slice(0, 3)).map(league => (
                        <div key={league.id} className="rounded-xl p-4 shadow-lg flex justify-between items-center" style={appStyles.card}>
                            <div className="flex-1 min-w-0">
                                <h3 className="font-bold text-lg">{league.name}</h3>
                                <p className="text-sm truncate" style={appStyles.hint}>{league.description}</p>
                                <p className="text-xs mt-2" style={appStyles.hint}>
                                    <Users size={14} className="inline mr-1 -mt-0.5" /> {league.members.toLocaleString()} members
                                </p>
                            </div>
                            <button 
                                onClick={() => showToast(`Simulated joining ${league.name}`)}
                                className="flex-shrink-0 ml-4 py-2 px-3 text-sm font-semibold rounded-lg hover:opacity-80" 
                                style={appStyles.button}
                            >
                                Join League
                            </button>
                        </div>
                    ))}
                    {!searchQuery && (
                        <p className="text-center py-2 text-sm" style={appStyles.hint}>Showing 3 popular leagues. Use search to find more.</p>
                    )}
                </div>

            </div>
        );
    };

    const TournamentsPage = () => (
        <div className="p-6 h-full flex items-center justify-center">
            <div className="text-center space-y-4 p-8 rounded-xl shadow-2xl" style={appStyles.card}>
                <Trophy size={64} className="mx-auto" style={appStyles.link} />
                <h2 className="text-2xl font-bold">Global Tournaments</h2>
                <p className="text-lg font-medium">Earn cash rewards by competing in weekly global tournaments.</p>
                <div className="p-3 rounded-lg font-semibold border-2 border-dashed" style={{ borderColor: theme.link_color, color: theme.link_color, backgroundColor: theme.link_color + '15' }}>
                    COMING SOON...
                </div>
                <p className="text-sm" style={appStyles.hint}>Stay tuned for announcements in our official Telegram channel.</p>
            </div>
        </div>
    );

    const ProfilePage = () => (
        <div className="p-4 space-y-6">
            
            {/* User Profile Section */}
            <div className="flex items-center space-x-4 p-4 rounded-xl shadow-lg" style={appStyles.card}>
                <img 
                    src={userData.avatarUrl} 
                    alt="User Avatar" 
                    className="w-16 h-16 rounded-full object-cover border-2" 
                    style={{ borderColor: theme.link_color }}
                    onError={(e) => e.target.src = `https://placehold.co/100x100/${theme.button_color.replace('#', '')}/${theme.button_text_color.replace('#', '')}?text=${userData.name.substring(0, 1)}`}
                />
                <div>
                    <p className="text-xl font-bold">{userData.name}</p>
                    <p className="text-sm font-medium" style={appStyles.hint}>@{userData.username}</p>
                    <p className="text-xs mt-1 font-mono" style={appStyles.hint}>User ID: {userId}</p>
                </div>
            </div>
            
            {/* Today's Tasks Section */}
            <div className="space-y-3">
                <h2 className="text-xl font-bold">Today's Tasks</h2>
                <div className="rounded-xl shadow-lg overflow-hidden" style={appStyles.card}>
                    {DAILY_TASKS.map((task, index) => (
                        <div key={index} className="flex justify-between items-center p-4 border-b last:border-b-0 transition duration-150 hover:opacity-90" style={{ borderColor: theme.hint_color + '30' }}>
                            <div className="flex-1 min-w-0">
                                <p className="font-medium truncate">{task.name}</p>
                                <div className="flex items-center mt-1 text-sm font-semibold text-yellow-500">
                                    <Zap size={16} className="mr-1" /> {task.points.toLocaleString()} Points
                                </div>
                            </div>
                            <button 
                                onClick={() => { window.open(task.url, '_blank'); Haptics.light(); }}
                                className="flex-shrink-0 ml-4 py-1 px-3 text-sm font-semibold rounded-lg hover:opacity-80" 
                                style={appStyles.button}
                            >
                                {task.action}
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );

    const renderPage = () => {
        switch (activePage) {
            case 'Home': return <HomePage />;
            case 'League': return <LeaguePage />;
            case 'Tournaments': return <TournamentsPage />;
            case 'Profile': return <ProfilePage />;
            default: return <HomePage />;
        }
    };
    
    // --- Render Main Application ---
    return (
        <div style={appStyles.body} className="min-h-screen pb-16 transition duration-300">
            {/* Content Area */}
            <div className="max-w-xl mx-auto w-full pb-4">
                {renderPage()}
            </div>
            
            {/* Navigation Bar */}
            <NavigationBar />
            
            {/* Modals */}
            {showModal === 'CreateLeague' && (
                <Modal title="Create New League" onClose={() => setShowModal(null)}>
                    <form onSubmit={handleCreateLeague} className="space-y-4 text-left">
                        <input
                            name="name"
                            type="text"
                            placeholder="League Name (e.g., Premier Quizzers)"
                            required
                            className="w-full p-3 rounded-lg focus:ring-2"
                            style={{ ...appStyles.card, border: `1px solid ${theme.hint_color}40`, color: theme.text_color }}
                        />
                        <textarea
                            name="description"
                            placeholder="Description (optional)"
                            rows="3"
                            className="w-full p-3 rounded-lg focus:ring-2 resize-none"
                            style={{ ...appStyles.card, border: `1px solid ${theme.hint_color}40`, color: theme.text_color }}
                        />
                        <div className="flex items-center space-x-2">
                            <input type="checkbox" name="isPrivate" id="isPrivate" className="h-4 w-4 rounded" style={{ accentColor: theme.link_color }} />
                            <label htmlFor="isPrivate" style={appStyles.hint}>This league is a private league (requires 6-digit code)</label>
                        </div>
                        <button type="submit" className="w-full py-3 rounded-xl font-semibold hover:opacity-90 transition" style={appStyles.button}>
                            Create League
                        </button>
                    </form>
                </Modal>
            )}

            {showModal === 'JoinLeague' && (
                <Modal title="Join Private League" onClose={() => setShowModal(null)}>
                    <form onSubmit={handleJoinLeague} className="space-y-4 text-left">
                        <input
                            name="code"
                            type="text"
                            placeholder="6-Digit Alpha-Numeric Code"
                            required
                            maxLength="6"
                            className="w-full p-3 text-center text-2xl font-mono tracking-widest rounded-lg focus:ring-2 uppercase"
                            style={{ ...appStyles.card, border: `1px solid ${theme.hint_color}40`, color: theme.text_color }}
                        />
                        <p className="text-center text-sm" style={appStyles.hint}>Ask the league owner for the private code.</p>
                        <button type="submit" className="w-full py-3 rounded-xl font-semibold hover:opacity-90 transition" style={appStyles.button}>
                            Search and Join
                        </button>
                    </form>
                </Modal>
            )}
            
            {showModal === 'ConfirmJoin' && showModal.league && (
                <Modal title="Confirm League Join" onClose={() => setShowModal(null)}>
                    <div className="text-center space-y-4">
                        <h3 className="text-xl font-bold">{showModal.league.name}</h3>
                        <p style={appStyles.hint}>{showModal.league.description}</p>
                        <div className="p-3 rounded-lg" style={appStyles.card}>
                            <p className="text-lg font-semibold">{showModal.league.members.toLocaleString()} Members</p>
                        </div>
                        
                        <p className="text-sm font-semibold">Do you want to join this league?</p>

                        <div className="flex space-x-4 pt-2">
                            <button 
                                onClick={() => setShowModal(null)} 
                                className="flex-1 py-3 rounded-xl font-semibold border-2 hover:opacity-80 transition"
                                style={{ borderColor: theme.hint_color, color: theme.hint_color, backgroundColor: theme.secondary_bg_color }}
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={() => confirmJoinLeague(showModal.league.id)} 
                                className="flex-1 py-3 rounded-xl font-semibold hover:opacity-90 transition" 
                                style={appStyles.button}
                            >
                                Confirm & Join
                            </button>
                        </div>
                    </div>
                </Modal>
            )}

            {showModal === 'Results' && quizResult && (
                <Modal title="Quiz Results" onClose={() => setShowModal(null)}>
                    <div className="text-center space-y-4">
                        <h3 className="text-3xl font-extrabold" style={appStyles.link}>{quizResult.pointsEarned} Points Earned!</h3>
                        <p className="text-sm font-medium" style={appStyles.hint}>Your score has been added to your profile.</p>
                        
                        <div className="grid grid-cols-2 gap-4 pt-2">
                            <div className="p-3 rounded-xl" style={appStyles.card}>
                                <p className="text-3xl font-bold text-green-500">{quizResult.correctAnswers}</p>
                                <p className="text-sm" style={appStyles.hint}>Correct Answers</p>
                            </div>
                            <div className="p-3 rounded-xl" style={appStyles.card}>
                                <p className="text-3xl font-bold">{quizResult.totalAnswered}</p>
                                <p className="text-sm" style={appStyles.hint}>Total Answered</p>
                            </div>
                            <div className="p-3 rounded-xl col-span-2" style={appStyles.card}>
                                <p className="text-3xl font-bold" style={appStyles.link}>{quizResult.accuracyRate}%</p>
                                <p className="text-sm" style={appStyles.hint}>Accuracy Rate</p>
                            </div>
                        </div>
                        
                        <button 
                            onClick={() => { setShowModal(null); setActivePage('Home'); }} 
                            className="w-full py-3 rounded-xl font-semibold mt-4 hover:opacity-90 transition" 
                            style={appStyles.button}
                        >
                            Back to Home
                        </button>
                    </div>
                </Modal>
            )}

            {showModal === 'Leaderboard' && (
                <Modal title="Global Leaderboard" onClose={() => setShowModal(null)}>
                    <p className="text-center font-semibold mb-4" style={appStyles.hint}>Top players worldwide in Footy IQ.</p>
                    {/* Simulated Leaderboard List */}
                    <div className="space-y-3">
                        {
                            [
                                { rank: 1, name: "Lionel Messi Fan", score: 50000, isSelf: false },
                                { rank: 2, name: "CR7 GOAT", score: 48500, isSelf: false },
                                { rank: 3, name: "Pele Forever", score: 45000, isSelf: false },
                                { rank: parseInt(userData.globalRank.replace('#', '')) || 4, name: userData.name, score: userData.score, isSelf: true }, // User's position
                                { rank: 5, name: "Anfield Klaw", score: 39000, isSelf: false },
                            ].sort((a, b) => a.rank - b.rank).map((player) => (
                                <div key={player.rank} className={`flex justify-between items-center p-3 rounded-xl ${player.isSelf ? 'border-2 border-yellow-500' : ''}`} style={appStyles.card}>
                                    <div className="flex items-center space-x-3">
                                        <span className={`font-extrabold text-lg w-6 text-center ${player.rank <= 3 ? 'text-yellow-500' : appStyles.hint.color}`}>{player.rank}</span>
                                        <span className="font-semibold">{player.name} {player.isSelf && '(You)'}</span>
                                    </div>
                                    <span className="font-bold">{player.score.toLocaleString()} Pts</span>
                                </div>
                            ))
                        }
                    </div>
                </Modal>
            )}
        </div>
    );
};

export default App;
