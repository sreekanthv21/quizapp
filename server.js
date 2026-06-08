const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

try {
  let serviceAccount;

  // Check for environment variable first (Best for Render/Production)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // Fallback to local file (Development)
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(serviceAccountPath)) {
      serviceAccount = require(serviceAccountPath);
    } else {
      throw new Error('No Firebase credentials found in environment or local file.');
    }
  }

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('Firebase Admin SDK initialized successfully.');
} catch (err) {
  console.error('CRITICAL ERROR: Failed to initialize Firebase Admin SDK:', err.message);
  process.exit(1);
}

const db = admin.firestore();

// Seed Default Administrator User on startup
async function seedDefaultAdmin() {
  try {
    const email = 'admin@quiz.com';
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
      console.log('Default admin user already exists in Firebase Auth.');
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        userRecord = await admin.auth().createUser({
          email: email,
          password: 'admin123',
          displayName: 'Professor Admin',
          emailVerified: true
        });
        console.log('Created default admin user in Firebase Auth.');
      } else {
        throw err;
      }
    }

    await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true, approved: true });

    const userDoc = db.collection('users').doc(userRecord.uid);
    await userDoc.set({
      email: email,
      role: 'admin',
      approved: true,
      displayName: 'Professor Admin',
      uid: userRecord.uid
    }, { merge: true });

    console.log('Default admin synchronized with Firestore.');
  } catch (err) {
    console.error('Error seeding default admin in Firebase:', err);
  }
}

// Run Startup Tasks
seedDefaultAdmin();

// Dynamic Client Firebase Config Endpoint
app.get('/api/firebase-config', (req, res) => {
  if (process.env.FIREBASE_API_KEY) {
    return res.json({
      enabled: true,
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID
    });
  }
  res.json({ enabled: false });
});

// 1. Authentication Sync Endpoints
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    
    if (!userDoc.exists) {
      return res.status(400).json({ success: false, error: 'email doesnot exist' });
    }
    
    return res.json({ success: true, user: userDoc.data() });
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      return res.status(400).json({ success: false, error: 'email doesnot exist' });
    }
    return res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, displayName, role, uid } = req.body;
  const userRole = role || (email.toLowerCase().includes('admin') ? 'admin' : 'student');
  const approved = userRole === 'admin' ? true : false;

  try {
    let finalUid = uid;

    // If client-side Firebase Auth didn't supply a uid, create the user in Firebase Auth using Admin SDK
    if (!finalUid) {
      let userRecord;
      try {
        userRecord = await admin.auth().getUserByEmail(email);
        finalUid = userRecord.uid;
        console.log(`User ${email} already exists in Firebase Auth. Re-using uid: ${finalUid}`);
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          userRecord = await admin.auth().createUser({
            email: email,
            password: password || 'studentDefault123',
            displayName: displayName || email.split('@')[0]
          });
          finalUid = userRecord.uid;
          console.log(`Created new Firebase Auth user: ${email} with uid: ${finalUid}`);
        } else {
          throw err;
        }
      }
    }

    const user = {
      email: email,
      role: userRole,
      approved: approved,
      displayName: displayName || email.split('@')[0],
      uid: finalUid
    };
    
    await db.collection('users').doc(finalUid).set(user);
    
    const claims = approved ? { admin: true, approved: true } : { approved: false };
    if (userRole === 'admin') {
      claims.admin = true;
    }
    await admin.auth().setCustomUserClaims(finalUid, claims);

    return res.json({ success: true, user });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
});

// 2. User Management Endpoints
app.get('/api/users', async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const list = [];
    snapshot.forEach(doc => list.push(doc.data()));
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/approve', async (req, res) => {
  const { email, approved } = req.body;
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    await db.collection('users').doc(userRecord.uid).update({ approved });
    
    const claims = approved ? { approved: true } : { approved: false };
    if (email.toLowerCase().includes('admin')) {
      claims.admin = true;
    }
    await admin.auth().setCustomUserClaims(userRecord.uid, claims);
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/users/profile', async (req, res) => {
  const { email } = req.query;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    if (userDoc.exists) {
      return res.json(userDoc.data());
    }
    return res.status(404).json({ error: 'User not found in Firestore' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post('/api/users/quiz-limits', async (req, res) => {
  const { email, quizId, limit } = req.body;
  if (!email || !quizId) {
    return res.status(400).json({ error: 'Email and quizId are required' });
  }
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    const userDoc = db.collection('users').doc(userRecord.uid);
    const doc = await userDoc.get();
    let quizLimits = {};
    if (doc.exists && doc.data().quizLimits) {
      quizLimits = doc.data().quizLimits;
    }
    quizLimits[quizId] = parseInt(limit);
    await userDoc.update({ quizLimits });
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// 3. Quiz Management Endpoints
app.get('/api/quizzes', async (req, res) => {
  try {
    const snapshot = await db.collection('quizzes').get();
    const list = [];
    snapshot.forEach(doc => list.push(doc.data()));
    return res.json(list);
  } catch (e) {
    console.error('Error fetching quizzes:', e);
    return res.status(500).json({ error: 'Failed to fetch quizzes: ' + e.message });
  }
});

app.post('/api/quizzes', async (req, res) => {
  const { id, title, description, timeLimit, attemptLimit } = req.body;
  const quizId = id || 'quiz_' + Date.now();
  const newQuiz = {
    id: quizId,
    title: title || 'New Quiz',
    description: description || '',
    timeLimit: parseInt(timeLimit) || 30,
    attemptLimit: parseInt(attemptLimit) || 1,
  };
  try {
    await db.collection('quizzes').doc(quizId).set(newQuiz);
    return res.json({ success: true, quiz: newQuiz });
  } catch (e) {
    console.error('Error creating quiz:', e);
    return res.status(400).json({ error: 'Failed to create quiz: ' + e.message });
  }
});

app.put('/api/quizzes/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, timeLimit, attemptLimit } = req.body;
  try {
    await db.collection('quizzes').doc(id).update({
      title,
      description,
      timeLimit: parseInt(timeLimit),
      attemptLimit: parseInt(attemptLimit),
    });
    return res.json({ success: true });
  } catch (e) {
    console.error(`Error updating quiz ${id}:`, e);
    return res.status(400).json({ error: 'Failed to update quiz: ' + e.message });
  }
});

app.delete('/api/quizzes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.collection('quizzes').doc(id).delete();
    // Delete associated questions and scores
    const questionsSnapshot = await db.collection('questions').where('quizId', '==', id).get();
    const qBatch = db.batch();
    questionsSnapshot.forEach(doc => qBatch.delete(doc.ref));
    if (!questionsSnapshot.empty) {
      await qBatch.commit();
    }

    const scoresSnapshot = await db.collection('scores').where('quizId', '==', id).get();
    const sBatch = db.batch();
    scoresSnapshot.forEach(doc => sBatch.delete(doc.ref));
    if (!scoresSnapshot.empty) {
      await sBatch.commit();
    }

    return res.json({ success: true });
  } catch (e) {
    console.error(`Error deleting quiz ${id}:`, e);
    return res.status(400).json({ error: 'Failed to delete quiz: ' + e.message });
  }
});

app.post('/api/quizzes/limit', async (req, res) => {
  const { quizId, limit } = req.body;
  if (!quizId || limit === undefined) {
    return res.status(400).json({ error: 'Quiz ID and limit are required' });
  }
  try {
    await db.collection('quizzes').doc(quizId).update({ attemptLimit: parseInt(limit) });
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// ── Quiz Session Endpoints (Persistent Timer & Session Locking) ──

// Helper to automatically submit an expired session
async function autoSubmitSession(sessionRef, session) {
  try {
    const { email, quizId, answers } = session;
    console.log(`Auto-submitting expired session ${sessionRef.id} for ${email}`);

    // Fetch questions
    const qSnapshot = await db.collection('questions').where('quizId', '==', quizId).get();
    const questions = [];
    qSnapshot.forEach(doc => questions.push(doc.data()));

    // Fetch quiz metadata
    const quizDoc = await db.collection('quizzes').doc(quizId).get();
    const quizTitle = quizDoc.exists ? quizDoc.data().title : 'General Quiz';

    let score = 0;
    let maxScore = 0;
    let correctCount = 0;
    let incorrectCount = 0;

    questions.forEach(q => {
      maxScore += q.marks;
      const selected = answers[q.id];
      if (selected === undefined || selected === null) {
        // Skipped
      } else if (parseInt(selected) === q.correctIndex) {
        score += q.marks;
        correctCount++;
      } else {
        score += q.negativeMarks;
        incorrectCount++;
      }
    });

    const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
    let grade = 'F';
    if (pct >= 90) grade = 'A+';
    else if (pct >= 80) grade = 'A';
    else if (pct >= 70) grade = 'B';
    else if (pct >= 60) grade = 'C';
    else if (pct >= 50) grade = 'D';

    const newScore = {
      email,
      quizId,
      quizTitle,
      score: parseFloat(score.toFixed(2)),
      maxScore,
      correctCount,
      incorrectCount,
      grade,
      answers: answers || {},
      timestamp: new Date().toISOString(),
      autoSubmitted: true
    };

    await db.collection('scores').add(newScore);
    await sessionRef.update({ status: 'completed' });
    console.log(`Successfully auto-submitted expired session ${sessionRef.id} for ${email}`);
  } catch (err) {
    console.error(`Failed to auto-submit expired session ${sessionRef.id}:`, err);
    // fallback: just update status to prevent infinite loop
    await sessionRef.update({ status: 'expired' });
  }
}

// Helper to find and clean up all expired active sessions
async function cleanExpiredSessions(email) {
  try {
    let queryRef = db.collection('quiz_sessions').where('status', '==', 'active');
    if (email) {
      queryRef = queryRef.where('email', '==', email);
    }
    const snapshot = await queryRef.get();
    for (const doc of snapshot.docs) {
      const session = doc.data();
      const startTime = new Date(session.startTime).getTime();
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = session.durationSeconds - elapsed;
      if (remaining <= 0) {
        await autoSubmitSession(doc.ref, session);
      }
    }
  } catch (err) {
    console.error('Error cleaning expired sessions:', err);
  }
}

// Start or resume a quiz session
app.post('/api/quiz-session/start', async (req, res) => {
  const { email, quizId } = req.body;
  if (!email || !quizId) {
    return res.status(400).json({ error: 'Email and quizId are required' });
  }
  try {
    // Clean expired sessions for this student first
    await cleanExpiredSessions(email);

    // Check if there's any active session for this student
    const activeSessions = await db.collection('quiz_sessions')
      .where('email', '==', email)
      .where('status', '==', 'active')
      .get();

    for (const doc of activeSessions.docs) {
      const session = doc.data();
      const startTime = new Date(session.startTime).getTime();
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = session.durationSeconds - elapsed;

      if (remaining > 0) {
        // Active session still has time
        if (session.quizId === quizId) {
          // Resume existing session for same quiz
          return res.json({
            success: true,
            sessionId: doc.id,
            secondsRemaining: Math.max(0, Math.floor(remaining)),
            answers: session.answers || {},
            resumed: true
          });
        } else {
          // Different quiz is active - block
          return res.status(409).json({
            success: false,
            error: 'You have an active session for another quiz. Complete or wait for it to expire.',
            activeQuizId: session.quizId
          });
        }
      } else {
        // Session expired - mark as expired
        await doc.ref.update({ status: 'expired' });
      }
    }

    // No active session - create a new one
    const quizDoc = await db.collection('quizzes').doc(quizId).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    const quizData = quizDoc.data();
    const durationSeconds = (quizData.timeLimit || 30) * 60;

    const sessionData = {
      email,
      quizId,
      startTime: new Date().toISOString(),
      durationSeconds,
      status: 'active',
      answers: {}
    };

    const sessionRef = await db.collection('quiz_sessions').add(sessionData);
    return res.json({
      success: true,
      sessionId: sessionRef.id,
      secondsRemaining: durationSeconds,
      answers: {},
      resumed: false
    });
  } catch (e) {
    console.error('Error starting quiz session:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Get current active session status for a student
app.get('/api/quiz-session/status', async (req, res) => {
  const { email } = req.query;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  try {
    // Clean expired sessions for this student first
    await cleanExpiredSessions(email);

    const activeSessions = await db.collection('quiz_sessions')
      .where('email', '==', email)
      .where('status', '==', 'active')
      .get();

    for (const doc of activeSessions.docs) {
      const session = doc.data();
      const startTime = new Date(session.startTime).getTime();
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = session.durationSeconds - elapsed;

      if (remaining > 0) {
        return res.json({
          active: true,
          sessionId: doc.id,
          quizId: session.quizId,
          secondsRemaining: Math.max(0, Math.floor(remaining)),
          answers: session.answers || {}
        });
      } else {
        // Expired - mark it
        await doc.ref.update({ status: 'expired' });
      }
    }

    return res.json({ active: false });
  } catch (e) {
    console.error('Error checking quiz session status:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Save quiz progress mid-session
app.post('/api/quiz-session/save-progress', async (req, res) => {
  const { sessionId, answers } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    const sessionRef = db.collection('quiz_sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await sessionRef.update({ answers: answers || {} });
    return res.json({ success: true });
  } catch (e) {
    console.error('Error saving quiz progress:', e);
    return res.status(500).json({ error: e.message });
  }
});


// 4. Question Endpoints
app.get('/api/questions', async (req, res) => {
  const { quizId } = req.query;
  try {
    let queryRef = db.collection('questions');
    if (quizId) {
      queryRef = queryRef.where('quizId', '==', quizId);
    }
    const snapshot = await queryRef.get();
    const list = [];
    snapshot.forEach(doc => list.push(doc.data()));
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/questions', async (req, res) => {
  const { id, quizId, text, codeSnippet, options, correctIndex, marks, negativeMarks } = req.body;
  const qId = id || 'q_' + Date.now(); // Ensure quizId is passed from frontend

  const newQuestion = {
    id: qId,
    quizId: quizId || 'quiz1',
    text,
    codeSnippet: codeSnippet || '',
    options,
    correctIndex: parseInt(correctIndex),
    marks: parseFloat(marks),
    negativeMarks: parseFloat(negativeMarks)
  };

  try {
    await db.collection('questions').doc(qId).set(newQuestion);
    return res.json({ success: true, question: newQuestion });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.delete('/api/questions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.collection('questions').doc(id).delete();
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// 5. Themes Endpoints
app.get('/api/theme', async (req, res) => {
  try {
    // Fetch dark theme settings
    const darkDoc = await db.collection('settings').doc('theme_dark').get();
    // Fetch light theme settings
    const lightDoc = await db.collection('settings').doc('theme_light').get();

    const defaultDarkTheme = {
      primary: '#00f2fe',
      background: '#0d111b',
      textColor: '#ffffff',
      accent: '#ff007f',
      headingColor: '#ffffff',
      subtitleColor: '#94a3b8',
      snackBarBg: '#228b22',
      snackBarText: '#ffffff',
      cardColor: '#151e2e',
      appBarBg: '#0d111b',
      appBarText: '#ffffff',
      fontFamily: 'Outfit',
    };
    const darkTheme = darkDoc.exists ? darkDoc.data() : defaultDarkTheme;

    const defaultLightTheme = {
      primary: '#4f46e5',
      background: '#f8fafc',
      textColor: '#0f172a',
      accent: '#f43f5e',
      headingColor: '#0f172a',
      subtitleColor: '#64748b',
      snackBarBg: '#228b22',
      snackBarText: '#ffffff',
      cardColor: '#ffffff',
      appBarBg: '#ffffff',
      appBarText: '#0f172a', // Default AppBar text color for light mode
      fontFamily: 'Outfit',
    };
    const lightTheme = lightDoc.exists ? lightDoc.data() : defaultLightTheme;
    
    return res.json({ dark: darkTheme, light: lightTheme });
  } catch (e) {
    // Return default fallback
  }
  res.json({
    dark: {
      primary: '#00f2fe',
      background: '#0d111b', // Corrected default background for dark mode
      textColor: '#ffffff',
      accent: '#ff007f',
      headingColor: '#ffffff',
      subtitleColor: '#94a3b8',
      snackBarBg: '#228b22',
      snackBarText: '#ffffff',
      cardColor: '#151e2e',
      appBarBg: '#0d111b',
      appBarText: '#ffffff',
      fontFamily: 'Outfit'
    },
    light: {
      primary: '#4f46e5',
      background: '#f8fafc', // Corrected default background for light mode
      textColor: '#0f172a',
      accent: '#f43f5e',
      headingColor: '#0f172a',
      subtitleColor: '#64748b',
      snackBarBg: '#228b22',
      snackBarText: '#ffffff',
      cardColor: '#ffffff',
      appBarBg: '#ffffff',
      appBarText: '#0f172a',
      fontFamily: 'Outfit'
    }
  });
});
// The existing POST /api/theme endpoint already handles mode, appBarBg, and appBarText.
app.post('/api/theme', async (req, res) => {
  const { mode, primary, background, textColor, accent, fontFamily, headingColor, subtitleColor, snackBarBg, snackBarText, cardColor, appBarBg, appBarText } = req.body;
  const targetMode = mode === 'light' ? 'theme_light' : 'theme_dark';
  
  const theme = {
    primary,
    background,
    textColor,
    accent,
    fontFamily: fontFamily || 'Outfit',
    headingColor: headingColor || (mode === 'light' ? '#0f172a' : '#ffffff'),
    subtitleColor: subtitleColor || (mode === 'light' ? '#64748b' : '#94a3b8'),
    snackBarBg: snackBarBg || '#228b22',
    snackBarText: snackBarText || '#ffffff',
    cardColor: cardColor || (mode === 'light' ? '#ffffff' : '#151e2e'),
    appBarBg: appBarBg || (mode === 'light' ? '#ffffff' : '#0d111b'),
    appBarText: appBarText || (mode === 'light' ? '#0f172a' : '#ffffff')
  };
  try {
    await db.collection('settings').doc(targetMode).set(theme);
    return res.json({ success: true, theme });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// 6. Score Submission Endpoints
app.post('/api/submit-quiz', async (req, res) => {
  const { email, answers, quizId } = req.body;
  try {
    // Verify active session exists and is valid (not expired)
    const activeSessions = await db.collection('quiz_sessions')
      .where('email', '==', email)
      .where('quizId', '==', quizId)
      .where('status', '==', 'active')
      .get();
      
    if (activeSessions.empty) {
      return res.status(403).json({ error: 'No active session found for this quiz. Submission rejected.' });
    }

    const sessionDoc = activeSessions.docs[0];
    const session = sessionDoc.data();
    const startTime = new Date(session.startTime).getTime();
    const elapsed = (Date.now() - startTime) / 1000;
    // Allow a 15-second grace period for latency
    if (elapsed > session.durationSeconds + 15) {
      // Session has expired beyond grace period. Auto-submit based on their last saved progress.
      await autoSubmitSession(sessionDoc.ref, session);
      return res.status(403).json({ error: 'Quiz time limit exceeded. Progress auto-submitted.' });
    }

    // Fetch questions
    const qSnapshot = await db.collection('questions').where('quizId', '==', quizId).get();
    const questions = [];
    qSnapshot.forEach(doc => questions.push(doc.data()));

    // Fetch quiz metadata
    const quizDoc = await db.collection('quizzes').doc(quizId).get();
    const quizTitle = quizDoc.exists ? quizDoc.data().title : 'General Quiz';
    
    let score = 0;
    let maxScore = 0;
    let correctCount = 0;
    let incorrectCount = 0;

    questions.forEach(q => {
      maxScore += q.marks;
      const selected = answers[q.id];
      if (selected === undefined) {
        // Skipped
      } else if (parseInt(selected) === q.correctIndex) {
        score += q.marks;
        correctCount++;
      } else {
        score += q.negativeMarks;
        incorrectCount++;
      }
    });

    const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
    let grade = 'F';
    if (pct >= 90) grade = 'A+';
    else if (pct >= 80) grade = 'A';
    else if (pct >= 70) grade = 'B';
    else if (pct >= 60) grade = 'C';
    else if (pct >= 50) grade = 'D';

    const newScore = {
      email,
      quizId,
      quizTitle,
      score: parseFloat(score.toFixed(2)),
      maxScore,
      correctCount,
      incorrectCount,
      grade,
      answers,
      timestamp: new Date().toISOString()
    };

    await db.collection('scores').add(newScore);

    // Mark the active quiz session as completed to release the lock
    for (const doc of activeSessions.docs) {
      await doc.ref.update({ status: 'completed' });
    }

    return res.json({ success: true, result: newScore });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/scores', async (req, res) => {
  const { email } = req.query;
  try {
    // Clean up any expired sessions first to ensure scores list is up-to-date
    await cleanExpiredSessions(email);

    let queryRef = db.collection('scores');
    if (email) {
      queryRef = queryRef.where('email', '==', email);
    }
    const snapshot = await queryRef.get();
    const list = [];
    snapshot.forEach(doc => list.push(doc.data()));
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    message: "Online Quiz Platform API is running.",
    status: "Healthy",
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export the app for Vercel serverless functions
module.exports = app;
