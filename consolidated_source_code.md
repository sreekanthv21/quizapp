# Online Quiz Platform - Consolidated Source Code

This file contains the complete source code for all backend files, fallback database configurations, and Flutter Web frontend views.

---

## File: `server.js`

```javascript
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

// Log browser console errors to server console
app.post('/api/log-error', (req, res) => {
  console.error('\n--- BROWSER CONSOLE ERROR ---');
  console.error(req.body);
  console.error('-----------------------------\n');
  res.sendStatus(200);
});

// Initialize Firebase Admin SDK (Mandatory)
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('CRITICAL ERROR: serviceAccountKey.json is required to run this project in Firebase mode!');
  process.exit(1);
}

try {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully.');
} catch (err) {
  console.error('CRITICAL ERROR: Failed to initialize Firebase Admin SDK:', err);
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

// Clean up scores of deprecated quizzes in Firestore on startup
async function cleanDeprecatedScores() {
  try {
    const activeQuizIds = ['python_quiz', 'sql_quiz'];
    const snapshot = await db.collection('scores').get();
    let deleteCount = 0;
    const batch = db.batch();
    snapshot.forEach(doc => {
      const data = doc.data();
      if (!activeQuizIds.includes(data.quizId)) {
        batch.delete(doc.ref);
        deleteCount++;
      }
    });
    if (deleteCount > 0) {
      await batch.commit();
      console.log(`Startup Firestore Cleanup: Removed ${deleteCount} scores for deprecated quizzes.`);
    }
  } catch (err) {
    console.error('Error cleaning up deprecated Firestore scores on startup:', err);
  }
}

// Run Startup Tasks
seedDefaultAdmin();
cleanDeprecatedScores();

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

// 3. Quizzes list endpoint
app.get('/api/quizzes', async (req, res) => {
  try {
    const snapshot = await db.collection('quizzes').get();
    const list = [];
    snapshot.forEach(doc => list.push(doc.data()));
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/quizzes/limit', async (req, res) => {
  const { quizId, limit } = req.body;
  if (!quizId || limit === undefined) {
    return res.status(400).json({ error: 'quizId and limit are required' });
  }
  try {
    await db.collection('quizzes').doc(quizId).update({ attemptLimit: parseInt(limit) });
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
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
  const qId = id || 'q_' + Date.now();

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
    const doc = await db.collection('settings').doc('theme').get();
    if (doc.exists) {
      return res.json(doc.data());
    }
  } catch (e) {
    // Return fallback if connection fails or doc missing
  }
  res.json({
    primary: '#00f2fe',
    background: '#0d111b',
    textColor: '#ffffff',
    accent: '#ff007f'
  });
});

app.post('/api/theme', async (req, res) => {
  const { primary, background, textColor, accent, fontFamily } = req.body;
  const theme = { primary, background, textColor, accent, fontFamily: fontFamily || 'Outfit' };
  try {
    await db.collection('settings').doc('theme').set(theme);
    return res.json({ success: true, theme });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// 6. Score Submission Endpoints
app.post('/api/submit-quiz', async (req, res) => {
  const { email, answers, quizId } = req.body;
  try {
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
    return res.json({ success: true, result: newScore });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/scores', async (req, res) => {
  const { email } = req.query;
  try {
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

// Serve compiled Flutter Web frontend if it exists
const FLUTTER_WEB_PATH = path.join(__dirname, 'flutter_quiz_app', 'build', 'web');
if (fs.existsSync(FLUTTER_WEB_PATH)) {
  app.use(express.static(FLUTTER_WEB_PATH, {
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
  }));
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(FLUTTER_WEB_PATH, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send(`
      <html>
        <head>
          <title>Quiz Platform Backend</title>
          <style>
            body { font-family: sans-serif; background: #0d111b; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #161b22; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); text-align: center; max-width: 500px; }
            h1 { color: #00f2fe; margin-top: 0; }
            code { background: #21262d; padding: 4px 8px; border-radius: 4px; font-family: monospace; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Online Quiz Platform APIs</h1>
            <p>Backend Server is running successfully on port ${PORT}.</p>
            <p>Flutter Web frontend is not built yet. Run <code>npm run build</code> to compile it.</p>
          </div>
        </body>
      </html>
    `);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

```

---

## File: `flutter_quiz_app/lib/main.dart`

```dart
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:google_fonts/google_fonts.dart';
import 'theme_notifier.dart';
import 'api_service.dart';
import 'views/login_page.dart';
import 'views/pending_approval_page.dart';
import 'views/student_dashboard.dart';
import 'views/student_quiz_page.dart';
import 'views/admin_dashboard.dart';
import 'views/score_page.dart';

class MyCustomScrollBehavior extends MaterialScrollBehavior {
  @override
  Set<PointerDeviceKind> get dragDevices => {
        PointerDeviceKind.touch,
        PointerDeviceKind.mouse,
        PointerDeviceKind.trackpad,
      };

  @override
  ScrollPhysics getScrollPhysics(BuildContext context) {
    return const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics());
  }
}


void main() {
  runApp(
    ChangeNotifierProvider(
      create: (_) => ThemeNotifier(),
      child: const MyApp(),
    ),
  );
}

class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    _bootstrapApplication();
  }

  Future<void> _bootstrapApplication() async {
    // 1. Load Theme Colors
    try {
      final themeData = await ApiService.getTheme();
      if (themeData.isNotEmpty && mounted) {
        Provider.of<ThemeNotifier>(context, listen: false).updateTheme(
          primaryHex: themeData['primary'] ?? '#00F2FE',
          backgroundHex: themeData['background'] ?? '#0D111B',
          accentHex: themeData['accent'] ?? '#FFFF007F',
          textColorHex: themeData['textColor'] ?? '#FFFFFF',
          fontFamily: themeData['fontFamily'] ?? 'Outfit',
        );
      }
    } catch (e) {
      debugPrint('Failed to load initial server theme: $e');
    }

    // 2. Initialize Firebase Web SDK dynamically if options are supplied by the server
    try {
      final response = await ApiService.getFirebaseConfig();
      if (response != null && response['enabled'] == true) {
        await Firebase.initializeApp(
          options: FirebaseOptions(
            apiKey: response['apiKey']!,
            authDomain: response['authDomain']!,
            projectId: response['projectId']!,
            storageBucket: response['storageBucket']!,
            messagingSenderId: response['messagingSenderId']!,
            appId: response['appId']!,
          ),
        );
        ApiService.useFirebase = true;
        debugPrint('Firebase Client SDK initialized successfully.');
      } else {
        debugPrint('Firebase Client SDK operates in Local/Node.js fallback mode.');
      }
    } catch (e) {
      debugPrint('Firebase Client SDK setup skipped/failed: $e');
    }

    if (mounted) {
      setState(() {
        _initialized = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final themeNotifier = Provider.of<ThemeNotifier>(context);

    if (!_initialized) {
      return MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          backgroundColor: const Color(0xFF0D111B),
          body: const Center(
            child: CircularProgressIndicator(
              valueColor: AlwaysStoppedAnimation<Color>(Color(0xFF00F2FE)),
            ),
          ),
        ),
      );
    }

    return MaterialApp(
      title: 'Online Quiz Platform',
      debugShowCheckedModeBanner: false,
      scrollBehavior: MyCustomScrollBehavior(),
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: themeNotifier.background,
        primaryColor: themeNotifier.primary,
        colorScheme: ColorScheme.dark(
          primary: themeNotifier.primary,
          secondary: themeNotifier.accent,
          background: themeNotifier.background,
        ),
        textSelectionTheme: TextSelectionThemeData(
          cursorColor: themeNotifier.primary,
        ),
        textTheme: GoogleFonts.getTextTheme(themeNotifier.fontFamily, ThemeData.dark().textTheme),
        snackBarTheme: const SnackBarThemeData(
          backgroundColor: Color(0xFF228B22), // Forest Green
          contentTextStyle: TextStyle(color: Colors.white),
        ),
      ),
      home: const LoginPage(),
      routes: {
        '/login': (context) => const LoginPage(),
        '/pending': (context) => const PendingApprovalPage(),
        '/student_dashboard': (context) => const StudentDashboard(),
        '/student_quiz': (context) => const StudentQuizPage(),
        '/admin_dashboard': (context) => const AdminDashboard(),
        '/score': (context) => const ScorePage(),
      },
    );
  }
}

```

---

## File: `flutter_quiz_app/lib/api_service.dart`

```dart
import 'dart:convert';
import 'dart:html' as html;
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:firebase_auth/firebase_auth.dart' as fb;
import 'models/question.dart';

class ApiService {
  static String _currentUserEmail = '';
  static String _currentUserName = '';

  static String get currentUserEmail {
    try {
      if (kIsWeb) {
        return html.window.localStorage['currentUserEmail'] ?? '';
      }
    } catch (e) {
      debugPrint('Local storage read error: $e');
    }
    return _currentUserEmail;
  }
  static set currentUserEmail(String value) {
    _currentUserEmail = value;
    try {
      if (kIsWeb) {
        html.window.localStorage['currentUserEmail'] = value;
      }
    } catch (e) {
      debugPrint('Local storage write error: $e');
    }
  }

  static String get currentUserName {
    try {
      if (kIsWeb) {
        return html.window.localStorage['currentUserName'] ?? '';
      }
    } catch (e) {
      debugPrint('Local storage read error: $e');
    }
    return _currentUserName;
  }
  static set currentUserName(String value) {
    _currentUserName = value;
    try {
      if (kIsWeb) {
        html.window.localStorage['currentUserName'] = value;
      }
    } catch (e) {
      debugPrint('Local storage write error: $e');
    }
  }

  static bool useFirebase = false;

  static String get baseUrl {
    if (kIsWeb) {
      final base = Uri.base;
      if (base.host.isNotEmpty && (base.port == 3000 || base.host.contains('localhost'))) {
        return base.port == 3000 
            ? "${base.scheme}://${base.host}:${base.port}"
            : "${base.scheme}://${base.host}:3000";
      }
    }
    return "http://localhost:3000";
  }

  // 0. Fetch Config
  static Future<Map<String, dynamic>?> getFirebaseConfig() async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/firebase-config'));
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
    } catch (e) {
      debugPrint('Failed to get firebase-config: $e');
    }
    return null;
  }

  // 1. Auth Services (Hybrid Firebase + Express Backend)
  static Future<Map<String, dynamic>> login(String email, String password) async {
    try {
      if (useFirebase && password.isNotEmpty) {
        final userCredential = await fb.FirebaseAuth.instance.signInWithEmailAndPassword(
          email: email,
          password: password,
        );
        final user = userCredential.user;
        if (user == null) {
          return {'success': false, 'error': 'Authentication failed'};
        }
      }

      final response = await http.post(
        Uri.parse('$baseUrl/api/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'password': password}),
      );
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
      return {'success': false, 'error': 'Server returned code ${response.statusCode}'};
    } on fb.FirebaseAuthException catch (e) {
      return {'success': false, 'error': e.message ?? 'Authentication error'};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  static Future<Map<String, dynamic>> register(String email, String password, String displayName, String role) async {
    try {
      String? uid;
      if (useFirebase) {
        final userCredential = await fb.FirebaseAuth.instance.createUserWithEmailAndPassword(
          email: email,
          password: password,
        );
        final user = userCredential.user;
        if (user != null) {
          uid = user.uid;
          await user.updateDisplayName(displayName);
        }
      }

      final response = await http.post(
        Uri.parse('$baseUrl/api/auth/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'email': email,
          'password': password,
          'displayName': displayName,
          'role': role,
          'uid': uid
        }),
      );
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
      return {'success': false, 'error': jsonDecode(response.body)['error'] ?? 'Registration failed'};
    } on fb.FirebaseAuthException catch (e) {
      return {'success': false, 'error': e.message ?? 'Registration error'};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  // 2. User Management
  static Future<List<dynamic>> getUsers() async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/users'));
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
      return [];
    } catch (e) {
      debugPrint('Error getting users: $e');
      return [];
    }
  }

  static Future<bool> approveUser(String email, bool approved) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/users/approve'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'approved': approved}),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('Error approving user: $e');
      return false;
    }
  }

  // 3. Theme Services
  static Future<Map<String, dynamic>> getTheme() async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/theme'));
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
      return {};
    } catch (e) {
      debugPrint('Error getting theme: $e');
      return {};
    }
  }

  static Future<bool> saveTheme(Map<String, String> themeData) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/theme'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(themeData),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('Error saving theme: $e');
      return false;
    }
  }

  // 4. Quiz Details
  static Future<List<dynamic>> getQuizzes() async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/quizzes'));
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
      return [];
    } catch (e) {
      debugPrint('Error getting quizzes: $e');
      return [];
    }
  }

  // 5. Question Services (filters by quizId)
  static Future<List<Question>> getQuestions([String quizId = '']) async {
    try {
      final url = quizId.isEmpty 
          ? '$baseUrl/api/questions' 
          : '$baseUrl/api/questions?quizId=$quizId';
      final response = await http.get(Uri.parse(url));
      if (response.statusCode == 200) {
        final List list = jsonDecode(response.body);
        return list.map((item) => Question.fromJson(item)).toList();
      }
      return [];
    } catch (e) {
      debugPrint('Error getting questions: $e');
      return [];
    }
  }

  static Future<bool> saveQuestion(Question question) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/questions'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(question.toJson()),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('Error saving question: $e');
      return false;
    }
  }

  static Future<bool> deleteQuestion(String id) async {
    try {
      final response = await http.delete(Uri.parse('$baseUrl/api/questions/$id'));
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('Error deleting question: $e');
      return false;
    }
  }

  // 6. Submit Quiz & Score
  static Future<Map<String, dynamic>> submitQuiz(String email, Map<String, int?> answers, String quizId) async {
    try {
      final cleanAnswers = <String, int>{};
      answers.forEach((key, value) {
        if (value != null) {
          cleanAnswers[key] = value;
        }
      });

      final response = await http.post(
        Uri.parse('$baseUrl/api/submit-quiz'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'email': email, 
          'answers': cleanAnswers,
          'quizId': quizId
        }),
      );
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
      return {'success': false, 'error': 'Submission failed'};
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    }
  }

  // 7. Get Score History
  static Future<List<dynamic>> getScores(String email) async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/scores?email=$email'));
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      }
      return [];
    } catch (e) {
      debugPrint('Error getting scores: $e');
      return [];
    }
  }

  static Future<Map<String, dynamic>?> getUserProfile(String email) async {
    try {
      final response = await http.get(Uri.parse('$baseUrl/api/users/profile?email=$email'));
      if (response.statusCode == 200) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
    } catch (e) {
      debugPrint('Error getting user profile: $e');
    }
    return null;
  }

  static Future<bool> saveQuizLimit(String email, String quizId, int limit) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/users/quiz-limits'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'email': email,
          'quizId': quizId,
          'limit': limit,
        }),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('Error saving quiz limit: $e');
      return false;
    }
  }

  static Future<bool> saveQuizLimitGlobal(String quizId, int limit) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/quizzes/limit'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'quizId': quizId,
          'limit': limit,
        }),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('Error saving global quiz limit: $e');
      return false;
    }
  }
}

```

---

## File: `flutter_quiz_app/lib/theme_notifier.dart`

```dart
import 'package:flutter/material.dart';

class ThemeNotifier with ChangeNotifier {
  Color _background = const Color(0xFF0D111B); // Premium deep dark
  Color _primary = const Color(0xFF00F2FE);    // Neon Teal
  Color _accent = const Color(0xFFFF007F);     // Neon Pink
  Color _textColor = Colors.white;
  bool _isDarkMode = true;
  String _fontFamily = 'Outfit';

  Color get background => _background;
  Color get primary => _primary;
  Color get accent => _accent;
  Color get textColor => _textColor;
  bool get isDarkMode => _isDarkMode;
  String get fontFamily => _fontFamily;

  void toggleTheme() {
    _isDarkMode = !_isDarkMode;
    if (_isDarkMode) {
      _background = const Color(0xFF0D111B);
      _primary = const Color(0xFF00F2FE);
      _accent = const Color(0xFFFF007F);
      _textColor = Colors.white;
    } else {
      _background = const Color(0xFFF8FAFC); // Slate 50
      _primary = const Color(0xFF4F46E5);    // Indigo 600
      _accent = const Color(0xFFF43F5E);     // Rose 500
      _textColor = const Color(0xFF0F172A);  // Slate 900
    }
    notifyListeners();
  }

  void updateTheme({
    required String primaryHex,
    required String backgroundHex,
    required String accentHex,
    required String textColorHex,
    String fontFamily = 'Outfit',
  }) {
    _primary = _parseColor(primaryHex, const Color(0xFF00F2FE));
    _background = _parseColor(backgroundHex, const Color(0xFF0D111B));
    _accent = _parseColor(accentHex, const Color(0xFFFF007F));
    _textColor = _parseColor(textColorHex, Colors.white);
    _fontFamily = fontFamily;
    notifyListeners();
  }

  Color _parseColor(String hex, Color fallback) {
    try {
      String cleanHex = hex.replaceAll('#', '');
      if (cleanHex.length == 6) {
        cleanHex = 'FF$cleanHex';
      }
      return Color(int.parse(cleanHex, radix: 16));
    } catch (_) {
      return fallback;
    }
  }

  String toHex(Color color) {
    return '#${color.value.toRadixString(16).padLeft(8, '0').substring(2)}';
  }
}

```

---

## File: `flutter_quiz_app/lib/models/question.dart`

```dart
class Question {
  final String id;
  final String text;
  final String codeSnippet;
  final List<String> options;
  final int correctIndex;
  final double marks;
  final double negativeMarks;

  Question({
    required this.id,
    required this.text,
    required this.codeSnippet,
    required this.options,
    required this.correctIndex,
    required this.marks,
    required this.negativeMarks,
  });

  factory Question.fromJson(Map<String, dynamic> json) {
    return Question(
      id: json['id'] as String? ?? '',
      text: json['text'] as String? ?? '',
      codeSnippet: json['codeSnippet'] as String? ?? '',
      options: List<String>.from(json['options'] ?? []),
      correctIndex: json['correctIndex'] as int? ?? 0,
      marks: (json['marks'] as num?)?.toDouble() ?? 1.0,
      negativeMarks: (json['negativeMarks'] as num?)?.toDouble() ?? 0.0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'text': text,
      'codeSnippet': codeSnippet,
      'options': options,
      'correctIndex': correctIndex,
      'marks': marks,
      'negativeMarks': negativeMarks,
    };
  }
}

```

---

## File: `flutter_quiz_app/lib/views/login_page.dart`

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api_service.dart';
import '../theme_notifier.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _nameController = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  
  bool _isSignUp = false;
  bool _isLoading = false;
  String _errorMessage = '';
  bool _obscurePassword = true;

  Future<void> _handleSubmit() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isLoading = true;
      _errorMessage = '';
    });

    final email = _emailController.text.trim();
    final password = _passwordController.text.trim();
    final name = _nameController.text.trim();

    try {
      if (_isSignUp) {
        // Registering a student user
        final res = await ApiService.register(email, password, name.isNotEmpty ? name : email.split('@')[0], 'student');
        if (res['success'] == true) {
          ApiService.currentUserEmail = email;
          ApiService.currentUserName = res['user']['displayName'] ?? email.split('@')[0];
          
          if (mounted) {
            Navigator.pushReplacementNamed(context, '/pending');
          }
        } else {
          setState(() {
            _errorMessage = res['error'] ?? 'Registration failed';
          });
        }
      } else {
        // Logging in
        final res = await ApiService.login(email, password);
        if (res['success'] == true) {
          final user = res['user'];
          ApiService.currentUserEmail = user['email'];
          ApiService.currentUserName = user['displayName'] ?? user['email'].split('@')[0];

          if (mounted) {
            if (user['role'] == 'admin') {
              Navigator.pushReplacementNamed(context, '/admin_dashboard');
            } else if (user['approved'] == true) {
              Navigator.pushReplacementNamed(context, '/student_dashboard');
            } else {
              Navigator.pushReplacementNamed(context, '/pending');
            }
          }
        } else {
          setState(() {
            _errorMessage = res['error'] ?? 'Login failed. Please verify credentials.';
          });
        }
      }
    } catch (e) {
      setState(() {
        _errorMessage = 'An unexpected error occurred: $e';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Provider.of<ThemeNotifier>(context);

    return Scaffold(
      body: Stack(
        children: [
          // Background subtle gradients
          Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: [
                  theme.background,
                  theme.background.withRed(20).withBlue(40),
                ],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
            ),
          ),
          // Floating ambient light blobs
          Positioned(
            top: -100,
            left: -100,
            child: Container(
              width: 300,
              height: 300,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: theme.primary.withOpacity(0.08),
              ),
            ),
          ),
          Positioned(
            bottom: -50,
            right: -50,
            child: Container(
              width: 250,
              height: 250,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: theme.accent.withOpacity(0.08),
              ),
            ),
          ),
          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24.0),
              child: Container(
                constraints: const BoxConstraints(maxWidth: 420),
                padding: const EdgeInsets.symmetric(horizontal: 32.0, vertical: 40.0),
                decoration: BoxDecoration(
                  color: Colors.white.withOpacity(0.03),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: Colors.white.withOpacity(0.08),
                    width: 1.5,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.3),
                      blurRadius: 30,
                      offset: const Offset(0, 15),
                    )
                  ],
                ),
                child: Form(
                  key: _formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Logo
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            Icons.track_changes,
                            color: theme.accent,
                            size: 32,
                          ),
                          const SizedBox(width: 12),
                          Text(
                            'RAPIDHUNT',
                            style: TextStyle(
                              fontSize: 26,
                              fontWeight: FontWeight.w900,
                              letterSpacing: 2,
                              color: theme.textColor,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Center(
                        child: Text(
                          _isSignUp ? 'Create Student Account' : 'Authorized Quiz Portal',
                          style: TextStyle(
                            color: theme.textColor.withOpacity(0.6),
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(height: 32),

                      if (_isSignUp) ...[
                        TextFormField(
                          controller: _nameController,
                          style: TextStyle(color: theme.textColor),
                          decoration: _inputDecoration('Full Name', Icons.person, theme),
                          validator: (val) => val == null || val.trim().isEmpty ? 'Enter your name' : null,
                        ),
                        const SizedBox(height: 16),
                      ],

                      TextFormField(
                        controller: _emailController,
                        style: TextStyle(color: theme.textColor),
                        keyboardType: TextInputType.emailAddress,
                        decoration: _inputDecoration('Email Address', Icons.email, theme),
                        validator: (val) {
                          if (val == null || val.trim().isEmpty) return 'Enter your email';
                          if (!val.contains('@')) return 'Enter a valid email';
                          return null;
                        },
                      ),
                      const SizedBox(height: 16),

                      TextFormField(
                        controller: _passwordController,
                        style: TextStyle(color: theme.textColor),
                        obscureText: _obscurePassword,
                        decoration: _inputDecoration('Password', Icons.lock, theme).copyWith(
                          suffixIcon: IconButton(
                            icon: Icon(
                              _obscurePassword ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                              color: theme.primary.withOpacity(0.6),
                              size: 20,
                            ),
                            onPressed: () {
                              setState(() {
                                _obscurePassword = !_obscurePassword;
                              });
                            },
                          ),
                        ),
                        validator: (val) {
                          if (val == null || val.trim().isEmpty) return 'Enter password';
                          if (val.length < 5) return 'Password must be at least 5 chars';
                          return null;
                        },
                      ),
                      const SizedBox(height: 12),

                      if (_errorMessage.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 8.0, bottom: 8.0),
                          child: Text(
                            _errorMessage,
                            style: TextStyle(color: theme.accent, fontSize: 13, fontWeight: FontWeight.w500),
                            textAlign: TextAlign.center,
                          ),
                        ),

                      const SizedBox(height: 24),

                      // Submit Button
                      ElevatedButton(
                        onPressed: _isLoading ? null : _handleSubmit,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: theme.accent,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 18),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                          elevation: 8,
                          shadowColor: theme.accent.withOpacity(0.4),
                        ),
                        child: _isLoading
                            ? const SizedBox(
                                height: 20,
                                width: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.5,
                                  valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                                ),
                              )
                            : Text(
                                _isSignUp ? 'SIGN UP' : 'SIGN IN',
                                style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: 1.5,
                                ),
                              ),
                      ),
                      const SizedBox(height: 24),

                      // Toggle Signup/Login
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            _isSignUp ? 'Already have an account? ' : "Don't have an account? ",
                            style: TextStyle(color: theme.textColor.withOpacity(0.5), fontSize: 13),
                          ),
                          MouseRegion(
                            cursor: SystemMouseCursors.click,
                            child: GestureDetector(
                              onTap: () {
                                setState(() {
                                  _isSignUp = !_isSignUp;
                                  _errorMessage = '';
                                });
                              },
                              child: Text(
                                _isSignUp ? 'Sign In' : 'Register Now',
                                style: TextStyle(
                                  color: theme.primary,
                                  fontSize: 13,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                          )
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          // Floating Theme Toggle Button
          Positioned(
            top: 24,
            right: 24,
            child: MouseRegion(
              cursor: SystemMouseCursors.click,
              child: IconButton(
                icon: Icon(
                  theme.isDarkMode ? Icons.light_mode_rounded : Icons.dark_mode_rounded,
                  color: theme.primary,
                  size: 28,
                ),
                onPressed: () {
                  theme.toggleTheme();
                },
                tooltip: theme.isDarkMode ? 'Switch to Light Theme' : 'Switch to Dark Theme',
              ),
            ),
          ),
        ],
      ),
    );
  }

  InputDecoration _inputDecoration(String label, IconData icon, ThemeNotifier theme) {
    return InputDecoration(
      labelText: label,
      labelStyle: TextStyle(color: theme.textColor.withOpacity(0.4), fontSize: 14),
      prefixIcon: Icon(icon, color: theme.primary.withOpacity(0.6), size: 20),
      filled: true,
      fillColor: Colors.white.withOpacity(0.01),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.white.withOpacity(0.08)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: theme.primary.withOpacity(0.8), width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: theme.accent.withOpacity(0.6)),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: theme.accent, width: 1.5),
      ),
      contentPadding: const EdgeInsets.symmetric(vertical: 18),
    );
  }
}

```

---

## File: `flutter_quiz_app/lib/views/pending_approval_page.dart`

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api_service.dart';
import '../theme_notifier.dart';

class PendingApprovalPage extends StatefulWidget {
  const PendingApprovalPage({super.key});

  @override
  State<PendingApprovalPage> createState() => _PendingApprovalPageState();
}

class _PendingApprovalPageState extends State<PendingApprovalPage> {
  bool _checking = false;
  String _message = 'Your account registration is currently pending authorization from the administrator. Please contact your instructor or supervisor.';

  Future<void> _checkStatus() async {
    setState(() {
      _checking = true;
      _message = 'Checking authorization status...';
    });

    try {
      final res = await ApiService.login(ApiService.currentUserEmail, '');
      if (res['success'] == true && res['user'] != null) {
        final user = res['user'];
        if (user['approved'] == true) {
          if (mounted) {
            Navigator.pushReplacementNamed(context, '/student_dashboard');
          }
          return;
        }
      }
      
      setState(() {
        _message = 'Your account is still pending approval. Please wait for administrator authorization.';
      });
    } catch (e) {
      setState(() {
        _message = 'Failed to check status. Server connection error.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _checking = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Provider.of<ThemeNotifier>(context);

    return Scaffold(
      body: Center(
        child: Container(
          constraints: const BoxConstraints(maxWidth: 480),
          margin: const EdgeInsets.all(24.0),
          padding: const EdgeInsets.all(40.0),
          decoration: BoxDecoration(
            color: Colors.white.withOpacity(0.02),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: Colors.white.withOpacity(0.08)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withOpacity(0.3),
                blurRadius: 30,
                offset: const Offset(0, 10),
              )
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.hourglass_empty_rounded,
                color: theme.primary,
                size: 72,
              ),
              const SizedBox(height: 28),
              Text(
                'Approval Pending',
                style: TextStyle(
                  color: theme.textColor,
                  fontSize: 24,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                _message,
                style: TextStyle(
                  color: theme.textColor.withOpacity(0.6),
                  fontSize: 14,
                  height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 36),
              
              if (_checking)
                const CircularProgressIndicator()
              else ...[
                ElevatedButton.icon(
                  onPressed: _checkStatus,
                  icon: const Icon(Icons.refresh),
                  label: const Text('CHECK STATUS'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: theme.primary,
                    foregroundColor: theme.background,
                    padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    textStyle: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1),
                  ),
                ),
                const SizedBox(height: 16),
                TextButton(
                  onPressed: () {
                    ApiService.currentUserEmail = '';
                    ApiService.currentUserName = '';
                    Navigator.pushReplacementNamed(context, '/login');
                  },
                  child: Text(
                    'Back to Login',
                    style: TextStyle(color: theme.textColor.withOpacity(0.5)),
                  ),
                )
              ]
            ],
          ),
        ),
      ),
    );
  }
}

```

---

## File: `flutter_quiz_app/lib/views/student_dashboard.dart`

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api_service.dart';
import '../theme_notifier.dart';

class StudentDashboard extends StatefulWidget {
  const StudentDashboard({super.key});

  @override
  State<StudentDashboard> createState() => _StudentDashboardState();
}

class _StudentDashboardState extends State<StudentDashboard> {
  List<dynamic> _quizzes = [];
  List<dynamic> _scores = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    if (ApiService.currentUserEmail.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Navigator.pushReplacementNamed(context, '/login');
      });
    } else {
      _loadDashboardData();
    }
  }

  Future<void> _loadDashboardData() async {
    setState(() => _isLoading = true);
    try {
      final quizzes = await ApiService.getQuizzes();
      final scores = await ApiService.getScores(ApiService.currentUserEmail);
      setState(() {
        _quizzes = quizzes;
        _scores = scores;
        _isLoading = false;
      });
    } catch (e) {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _showSignOutDialog() async {
    final theme = Provider.of<ThemeNotifier>(context, listen: false);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          backgroundColor: theme.background,
          title: Text('Sign Out', style: TextStyle(color: theme.textColor, fontWeight: FontWeight.bold)),
          content: Text('Are you sure you want to sign out?', style: TextStyle(color: theme.textColor.withOpacity(0.8))),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text('CANCEL', style: TextStyle(color: theme.primary, fontWeight: FontWeight.bold)),
            ),
            ElevatedButton(
              onPressed: () => Navigator.pop(context, true),
              style: ElevatedButton.styleFrom(
                backgroundColor: theme.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              ),
              child: const Text('SIGN OUT', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ],
        );
      },
    );
    if (confirmed == true && mounted) {
      ApiService.currentUserEmail = '';
      ApiService.currentUserName = '';
      Navigator.pushReplacementNamed(context, '/login');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Provider.of<ThemeNotifier>(context);
    final screenWidth = MediaQuery.of(context).size.width;
    final isDesktop = screenWidth > 800;

    return Scaffold(
      appBar: AppBar(
        title: const Text('RAPIDHUNT Assessment Portal', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1)),
        backgroundColor: Colors.white.withOpacity(0.01),
        elevation: 0,
        actions: [
          IconButton(
            icon: Icon(theme.isDarkMode ? Icons.light_mode : Icons.dark_mode, color: theme.primary),
            onPressed: () => theme.toggleTheme(),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: _showSignOutDialog,
          ),
          const SizedBox(width: 16),
        ],
      ),
      body: _isLoading
          ? Center(child: CircularProgressIndicator(color: theme.primary))
          : ScrollConfiguration(
              behavior: const ScrollBehavior().copyWith(
                physics: const BouncingScrollPhysics(),
              ),
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(32.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                  // Welcome banner
                  Text(
                    'Welcome back, ${ApiService.currentUserName}!',
                    style: TextStyle(
                      color: theme.textColor,
                      fontSize: 28,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Select an assessment below to start your evaluation, or review your historical performance scorecard.',
                    style: TextStyle(color: theme.textColor.withOpacity(0.5), fontSize: 14),
                  ),
                  const SizedBox(height: 36),

                  // Responsive split screen layout or vertical stack
                  if (isDesktop)
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Left section: Quizzes List
                        Expanded(
                          flex: 3,
                          child: _buildQuizzesSection(theme),
                        ),
                        const SizedBox(width: 32),
                        // Right section: Scorecards
                        Expanded(
                          flex: 2,
                          child: _buildScorecardsSection(theme),
                        ),
                      ],
                    )
                  else ...[
                    _buildQuizzesSection(theme),
                    const SizedBox(height: 36),
                    _buildScorecardsSection(theme),
                  ],
                ],
              ),
            ),
          ),
    );
  }

  Widget _buildQuizzesSection(ThemeNotifier theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Available Assessments',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 16),
        if (_quizzes.isEmpty)
          const Card(
            child: Padding(
              padding: EdgeInsets.all(24.0),
              child: Text('No assessments currently assigned.'),
            ),
          )
        else
          ListView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: _quizzes.length,
            itemBuilder: (context, index) {
              final quiz = _quizzes[index];
              final attemptsTaken = _scores.where((s) => s['quizId'] == quiz['id']).length;
              final limit = quiz['attemptLimit'] ?? 1;
              final hasAttemptsLeft = limit >= 999 || attemptsTaken < limit;
              final limitString = limit >= 999 ? 'Unlimited' : limit.toString();

              return Card(
                color: Colors.white.withOpacity(0.01),
                margin: const EdgeInsets.only(bottom: 16),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                  side: BorderSide(color: Colors.white.withOpacity(0.08)),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(24.0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text(
                              quiz['title'] ?? '',
                              style: TextStyle(color: theme.textColor, fontSize: 18, fontWeight: FontWeight.bold),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: (hasAttemptsLeft ? theme.primary : theme.accent).withOpacity(0.1),
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: (hasAttemptsLeft ? theme.primary : theme.accent).withOpacity(0.3),
                              ),
                            ),
                            child: Text(
                              'Attempts: $attemptsTaken / $limitString',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: hasAttemptsLeft ? theme.primary : theme.accent,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        quiz['description'] ?? '',
                        style: TextStyle(color: theme.textColor.withOpacity(0.5), fontSize: 14, height: 1.4),
                      ),
                      const SizedBox(height: 20),
                      ElevatedButton(
                        onPressed: hasAttemptsLeft
                            ? () {
                                Navigator.pushNamed(
                                  context,
                                  '/student_quiz',
                                  arguments: quiz['id'],
                                );
                              }
                            : null,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: theme.primary,
                          foregroundColor: theme.background,
                          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        child: Text(
                          hasAttemptsLeft ? 'Start Quiz' : 'Attempt Limit Reached',
                          style: const TextStyle(fontWeight: FontWeight.bold),
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
      ],
    );
  }

  Widget _buildScorecardsSection(ThemeNotifier theme) {
    final activeQuizIds = ['python_quiz', 'sql_quiz'];
    final scoresToDisplay = _scores.where((s) => activeQuizIds.contains(s['quizId'])).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Your Scorecard History',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 16),
        if (scoresToDisplay.isEmpty)
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.01),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.white.withOpacity(0.05)),
            ),
            child: const Text('No past scorecards recorded yet. Complete your first quiz to see scores here!'),
          )
        else
          ListView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: scoresToDisplay.length,
            itemBuilder: (context, index) {
              final score = scoresToDisplay[scoresToDisplay.length - 1 - index]; // latest first
              final double pct = score['maxScore'] > 0 ? (score['score'] / score['maxScore']) * 100 : 0.0;

              Color gradeColor = theme.primary;
              if (pct >= 80) {
                gradeColor = Colors.greenAccent;
              } else if (pct >= 50) {
                gradeColor = Colors.amberAccent;
              } else {
                gradeColor = theme.accent;
              }

              return Card(
                color: Colors.black.withOpacity(0.2),
                margin: const EdgeInsets.only(bottom: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                  side: BorderSide(color: Colors.white.withOpacity(0.05)),
                ),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: () {
                    debugPrint('StudentDashboard: opening historic exam review');
                    Navigator.pushNamed(
                      context,
                      '/student_quiz',
                      arguments: {
                        'quizId': score['quizId'],
                        'isReviewMode': true,
                        'answers': score['answers'],
                      },
                    );
                  },
                  hoverColor: theme.primary.withOpacity(0.05),
                  child: ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                    title: Text(
                      score['quizTitle'] ?? 'General Test',
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                    subtitle: Padding(
                      padding: const EdgeInsets.only(top: 6.0),
                      child: Text(
                        'Score: ${score['score']} / ${score['maxScore']} (${pct.toStringAsFixed(1)}%)',
                        style: TextStyle(color: theme.textColor.withOpacity(0.6), fontSize: 13),
                      ),
                    ),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                          decoration: BoxDecoration(
                            color: gradeColor.withOpacity(0.1),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: gradeColor.withOpacity(0.5)),
                          ),
                          child: Text(
                            score['grade'] ?? 'F',
                            style: TextStyle(color: gradeColor, fontWeight: FontWeight.bold, fontSize: 14),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Icon(Icons.chevron_right_rounded, color: theme.textColor.withOpacity(0.3)),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
      ],
    );
  }
}

```

---

## File: `flutter_quiz_app/lib/views/student_quiz_page.dart`

```dart
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api_service.dart';
import '../models/question.dart';
import '../theme_notifier.dart';

class StudentQuizPage extends StatefulWidget {
  const StudentQuizPage({super.key});

  @override
  State<StudentQuizPage> createState() => _StudentQuizPageState();
}

class _StudentQuizPageState extends State<StudentQuizPage> {
  List<Question> _questions = [];
  int _currentIndex = 0;
  bool _isLoading = true;
  String _quizId = 'quiz1';
  bool _didInit = false;

  // Answers tracker: { questionId: selectedIndex }
  final Map<String, int?> _answers = {};

  // Visited questions tracker
  final Set<int> _visitedIndices = {0};
  bool _isReviewMode = false;

  // For visual correct/wrong feedback on clicked options: { questionId: selectedIndex }
  // When a user selects an answer, we store it here to lock it and show green/red lights.
  final Map<String, int> _submittedAnswers = {};

  // Timer variables
  Timer? _timer;
  int _secondsLeft = 1800; // 30 minutes default
  String _timerString = '30:00';

  @override
  void initState() {
    super.initState();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_didInit) {
      if (ApiService.currentUserEmail.isEmpty) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          Navigator.pushReplacementNamed(context, '/login');
        });
        return;
      }
      final args = ModalRoute.of(context)!.settings.arguments;
      if (args is Map) {
        _quizId = args['quizId']?.toString() ?? 'quiz1';
        _isReviewMode = args['isReviewMode'] == true;
        if (_isReviewMode) {
          final answersRaw = args['answers'];
          if (answersRaw is Map) {
            answersRaw.forEach((k, v) {
              _answers[k.toString()] = v as int?;
            });
          }
        }
      } else if (args is String) {
        _quizId = args;
        _isReviewMode = false;
      } else {
        _quizId = 'quiz1';
        _isReviewMode = false;
      }
      _loadQuestions(_quizId);
      if (!_isReviewMode) {
        _startTimer();
      } else {
        _timerString = 'Review Mode';
      }
      _didInit = true;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startTimer() {
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_secondsLeft <= 0) {
        timer.cancel();
        _finishQuiz();
      } else {
        setState(() {
          _secondsLeft--;
          final minutes = (_secondsLeft ~/ 60).toString().padLeft(2, '0');
          final seconds = (_secondsLeft % 60).toString().padLeft(2, '0');
          _timerString = '$minutes:$seconds';
        });
      }
    });
  }

  Future<void> _loadQuestions(String quizId) async {
    try {
      final questions = await ApiService.getQuestions(quizId);
      setState(() {
        _questions = questions;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _selectOption(int optionIndex) {
    if (_isReviewMode) return;
    final question = _questions[_currentIndex];
    setState(() {
      _answers[question.id] = optionIndex;
    });
  }

  int get _answeredCount => _answers.values.where((v) => v != null).length;
  int get _skippedCount => _questions.length - _answeredCount;

  Future<void> _finishQuiz() async {
    _timer?.cancel();
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => const Center(
        child: CircularProgressIndicator(),
      ),
    );

    try {
      final result = await ApiService.submitQuiz(ApiService.currentUserEmail, _answers, _quizId);
      if (mounted) {
        Navigator.pop(context); // Dismiss loading
        if (result['success'] == true) {
          final scoreResult = Map<String, dynamic>.from(result['result'] as Map);
          scoreResult['answers'] = _answers;
          Navigator.pushReplacementNamed(
            context,
            '/score',
            arguments: scoreResult,
          );
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Submission failed. Server error.')),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error submitting quiz: $e')),
        );
      }
    }
  }

  void _navigateToQuestion(int index) {
    setState(() {
      _currentIndex = index;
      _visitedIndices.add(index);
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Provider.of<ThemeNotifier>(context);

    if (_isLoading) {
      return Scaffold(
        body: Center(
          child: CircularProgressIndicator(color: theme.primary),
        ),
      );
    }

    if (_questions.isEmpty) {
      return Scaffold(
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('No questions available in the database.'),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () => Navigator.pushReplacementNamed(context, '/login'),
                child: const Text('Back to Login'),
              ),
            ],
          ),
        ),
      );
    }

    final currentQuestion = _questions[_currentIndex];
    final screenWidth = MediaQuery.of(context).size.width;
    final isDesktop = screenWidth > 800;

    return Scaffold(
      body: Column(
        children: [
          // 1. Top Bar Header
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.02),
              border: Border(
                bottom: BorderSide(color: Colors.white.withOpacity(0.08)),
              ),
            ),
            child: Row(
              children: [
                // Logo
                Icon(Icons.track_changes, color: theme.accent, size: 28),
                const SizedBox(width: 8),
                Text(
                  'RAPIDHUNT',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                    color: theme.textColor,
                    letterSpacing: 1.5,
                  ),
                ),
                const Spacer(),
                // Timer
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  decoration: BoxDecoration(
                    color: Colors.black.withOpacity(0.4),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: theme.primary.withOpacity(0.3)),
                  ),
                  child: Text(
                    _timerString,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: theme.primary,
                    ),
                  ),
                ),
                const Spacer(),
                // User info & Finish Button
                Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: theme.primary.withOpacity(0.2),
                      radius: 18,
                      child: Text(
                        ApiService.currentUserName.isNotEmpty 
                            ? ApiService.currentUserName[0].toUpperCase() 
                            : 'U',
                        style: TextStyle(color: theme.primary, fontWeight: FontWeight.bold),
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (isDesktop)
                      Text(
                        ApiService.currentUserName,
                        style: TextStyle(color: theme.textColor.withOpacity(0.8), fontWeight: FontWeight.w600),
                      ),
                    const SizedBox(width: 20),
                    if (!_isReviewMode)
                      ElevatedButton(
                        onPressed: _finishQuiz,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: theme.accent,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                        ),
                        child: const Text('Finish', style: TextStyle(fontWeight: FontWeight.w800)),
                      )
                  ],
                ),
              ],
            ),
          ),
          
          // 2. Main Workspace Area
          Expanded(
            child: Row(
              children: [
                // LEFT SIDEBAR - Grid circular indicators + stats
                if (isDesktop) _buildLeftSidebar(theme),

                // CENTRAL WORKSPACE - Unified Question and Options Container
                Expanded(
                  child: Column(
                    children: [
                      Expanded(
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.all(32.0),
                          child: Container(
                            decoration: BoxDecoration(
                              color: Colors.white.withOpacity(0.02),
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(color: Colors.white.withOpacity(0.08)),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withOpacity(0.2),
                                  blurRadius: 20,
                                  offset: const Offset(0, 10),
                                )
                              ],
                            ),
                            padding: const EdgeInsets.all(32.0),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                // Question Header
                                Text(
                                  'Question ${_currentIndex + 1} of ${_questions.length}',
                                  style: TextStyle(color: theme.primary, fontSize: 13, fontWeight: FontWeight.bold, letterSpacing: 1),
                                ),
                                const SizedBox(height: 12),
                                // Question text (left aligned)
                                Text(
                                  currentQuestion.text,
                                  style: TextStyle(color: theme.textColor, fontSize: 18, fontWeight: FontWeight.bold, height: 1.45),
                                ),
                                
                                // Code Snippet if present
                                if (currentQuestion.codeSnippet.isNotEmpty) ...[
                                  const SizedBox(height: 20),
                                  Container(
                                    width: double.infinity,
                                    padding: const EdgeInsets.all(16),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFF161B22),
                                      borderRadius: BorderRadius.circular(8),
                                      border: Border.all(color: Colors.white.withOpacity(0.08)),
                                    ),
                                    child: SingleChildScrollView(
                                      scrollDirection: Axis.horizontal,
                                      child: Text(
                                        currentQuestion.codeSnippet,
                                        style: const TextStyle(
                                          fontFamily: 'monospace',
                                          fontSize: 13,
                                          color: Color(0xFF8B949E),
                                          height: 1.4,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],

                                const SizedBox(height: 28),

                                // Options in a 4-rowed single column vertical stack (left aligned)
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.stretch,
                                  children: List.generate(4, (index) {
                                    return Padding(
                                      padding: const EdgeInsets.only(bottom: 12.0),
                                      child: _buildOptionCard(
                                        index: index,
                                        text: currentQuestion.options[index],
                                        questionId: currentQuestion.id,
                                        theme: theme,
                                      ),
                                    );
                                  }),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),

                      // Question Navigation Controls
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 32.0, vertical: 16.0),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            ElevatedButton.icon(
                              onPressed: _currentIndex > 0
                                  ? () => _navigateToQuestion(_currentIndex - 1)
                                  : null,
                              icon: const Icon(Icons.arrow_back),
                              label: const Text('Previous'),
                              style: ElevatedButton.styleFrom(
                                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                              ),
                            ),
                            if (!isDesktop)
                              IconButton(
                                icon: const Icon(Icons.grid_on),
                                color: theme.primary,
                                onPressed: () {
                                  showModalBottomSheet(
                                    context: context,
                                    backgroundColor: theme.background,
                                    builder: (context) => _buildLeftSidebar(theme),
                                  );
                                },
                              ),
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (!_isReviewMode) ...[
                                  ElevatedButton.icon(
                                    onPressed: _finishQuiz,
                                    icon: const Icon(Icons.cloud_upload_rounded),
                                    label: const Text('Submit Quiz'),
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: theme.accent,
                                      foregroundColor: Colors.white,
                                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                    ),
                                  ),
                                  if (_currentIndex < _questions.length - 1)
                                    const SizedBox(width: 12),
                                ],
                                if (!_isReviewMode && _currentIndex < _questions.length - 1)
                                  ElevatedButton.icon(
                                    onPressed: () => _navigateToQuestion(_currentIndex + 1),
                                    icon: const Icon(Icons.arrow_forward),
                                    label: const Text('Next'),
                                    style: ElevatedButton.styleFrom(
                                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                                    ),
                                  ),
                                if (_isReviewMode) ...[
                                  ElevatedButton.icon(
                                    onPressed: () {
                                      Navigator.pushNamedAndRemoveUntil(context, '/student_dashboard', (route) => false);
                                    },
                                    icon: const Icon(Icons.home_rounded),
                                    label: const Text('Back to Home'),
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: theme.primary,
                                      foregroundColor: theme.background,
                                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                    ),
                                  ),
                                  if (_currentIndex < _questions.length - 1) ...[
                                    const SizedBox(width: 12),
                                    ElevatedButton.icon(
                                      onPressed: () => _navigateToQuestion(_currentIndex + 1),
                                      icon: const Icon(Icons.arrow_forward),
                                      label: const Text('Next'),
                                      style: ElevatedButton.styleFrom(
                                        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                                      ),
                                    ),
                                  ],
                                ],
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSidebarStatusRow(String label, String value, Color valueColor) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
        ),
        Text(
          value,
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: valueColor),
        ),
      ],
    );
  }

  // Sidebar widget displaying grid of question index and quiz stats
  Widget _buildLeftSidebar(ThemeNotifier theme) {
    return Container(
      width: 260,
      padding: const EdgeInsets.all(24.0),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.01),
        border: Border(
          right: BorderSide(color: Colors.white.withOpacity(0.08)),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Assessment Status',
            style: TextStyle(
              color: theme.textColor,
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 12),
          // Sidebar Stats Box
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.black.withOpacity(0.2),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.white.withOpacity(0.05)),
            ),
            child: Column(
              children: [
                _buildSidebarStatusRow('Total Questions:', '${_questions.length}', theme.textColor.withOpacity(0.7)),
                const SizedBox(height: 8),
                _buildSidebarStatusRow('Answered:', '$_answeredCount', theme.primary),
                const SizedBox(height: 8),
                _buildSidebarStatusRow('Remaining:', '$_skippedCount', theme.accent),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'Questions',
            style: TextStyle(
              color: theme.textColor,
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: GridView.builder(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 4,
                crossAxisSpacing: 10,
                mainAxisSpacing: 10,
              ),
              itemCount: _questions.length,
              itemBuilder: (context, index) {
                final qId = _questions[index].id;
                final isAnswered = _answers.containsKey(qId) && _answers[qId] != null;
                final isActive = index == _currentIndex;

                Color circleColor = Colors.transparent;
                Color borderColor = theme.primary.withOpacity(0.4);
                Color fontColor = theme.textColor.withOpacity(0.7);

                if (isActive) {
                  circleColor = theme.textColor;
                  borderColor = theme.textColor;
                  fontColor = theme.background;
                } else if (_isReviewMode) {
                  final correctIndex = _questions[index].correctIndex;
                  final userIndex = _answers[qId];
                  if (userIndex == null) {
                    circleColor = Colors.transparent;
                    borderColor = theme.textColor.withOpacity(0.2);
                    fontColor = theme.textColor.withOpacity(0.5);
                  } else if (userIndex == correctIndex) {
                    circleColor = Colors.green.withOpacity(0.15);
                    borderColor = Colors.green;
                    fontColor = Colors.green;
                  } else {
                    circleColor = Colors.red.withOpacity(0.15);
                    borderColor = Colors.red;
                    fontColor = Colors.red;
                  }
                } else {
                  if (isAnswered) {
                    circleColor = Colors.green.withOpacity(0.15);
                    borderColor = Colors.green;
                    fontColor = Colors.green;
                  } else if (_visitedIndices.contains(index)) {
                    circleColor = Colors.red.withOpacity(0.15);
                    borderColor = Colors.red;
                    fontColor = Colors.red;
                  } else {
                    circleColor = Colors.transparent;
                    borderColor = theme.primary;
                    fontColor = theme.primary;
                  }
                }

                return GestureDetector(
                  onTap: () {
                    _navigateToQuestion(index);
                    if (MediaQuery.of(context).size.width <= 800) {
                      Navigator.pop(context); // Close bottom sheet on mobile
                    }
                  },
                  child: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: circleColor,
                      border: Border.all(color: borderColor, width: 1.5),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                       '${index + 1}',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: fontColor,
                        fontSize: 14,
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  // Interactive option widget with custom cursor (discrete competitive style selection)
  Widget _buildOptionCard({
    required int index,
    required String text,
    required String questionId,
    required ThemeNotifier theme,
  }) {
    final prefix = String.fromCharCode(65 + index); // A, B, C, D
    final selectedIndex = _answers[questionId];
    final isSelected = selectedIndex == index;

    Color cardBorderColor;
    Color cardBgColor;
    Color prefixColor;

    if (_isReviewMode) {
      final correctIndex = _questions[_currentIndex].correctIndex;
      if (index == correctIndex) {
        cardBorderColor = Colors.green;
        cardBgColor = Colors.green.withOpacity(0.08);
        prefixColor = Colors.green;
      } else if (isSelected) {
        cardBorderColor = Colors.red;
        cardBgColor = Colors.red.withOpacity(0.08);
        prefixColor = Colors.red;
      } else {
        cardBorderColor = Colors.white.withOpacity(0.08);
        cardBgColor = Colors.white.withOpacity(0.01);
        prefixColor = theme.textColor.withOpacity(0.5);
      }
    } else {
      cardBorderColor = isSelected ? theme.primary : Colors.white.withOpacity(0.08);
      cardBgColor = isSelected ? theme.primary.withOpacity(0.06) : Colors.white.withOpacity(0.01);
      prefixColor = isSelected ? theme.primary : theme.textColor.withOpacity(0.5);
    }

    return _HoverableOptionCard(
      text: text,
      prefix: prefix,
      theme: theme,
      borderColor: cardBorderColor,
      backgroundColor: cardBgColor,
      prefixColor: prefixColor,
      isSelected: isSelected || (_isReviewMode && index == _questions[_currentIndex].correctIndex),
      isReadOnly: _isReviewMode,
      onTap: () => _selectOption(index),
    );
  }
}

// Custom widget to isolate Hover state and implement blinking text cursor
class _HoverableOptionCard extends StatefulWidget {
  final String text;
  final String prefix;
  final ThemeNotifier theme;
  final Color borderColor;
  final Color backgroundColor;
  final Color prefixColor;
  final bool isSelected;
  final bool isReadOnly;
  final VoidCallback onTap;

  const _HoverableOptionCard({
    required this.text,
    required this.prefix,
    required this.theme,
    required this.borderColor,
    required this.backgroundColor,
    required this.prefixColor,
    required this.isSelected,
    this.isReadOnly = false,
    required this.onTap,
  });

  @override
  State<_HoverableOptionCard> createState() => _HoverableOptionCardState();
}

class _HoverableOptionCardState extends State<_HoverableOptionCard> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    // Dynamically adjust styling if hovered
    Color currentBorderColor = widget.borderColor;
    Color currentBgColor = widget.backgroundColor;

    if (_isHovered && !widget.isSelected && !widget.isReadOnly) {
      currentBorderColor = widget.theme.primary.withOpacity(0.8);
      currentBgColor = widget.theme.primary.withOpacity(0.04);
    }

    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      cursor: widget.isReadOnly ? SystemMouseCursors.basic : SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
            color: currentBgColor,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: currentBorderColor, width: _isHovered ? 1.5 : 1.0),
          ),
          child: Row(
            children: [
              // Circular Prefix Indicator (Smaller: 28x28)
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: widget.prefixColor.withOpacity(0.1),
                ),
                alignment: Alignment.center,
                child: Text(
                  widget.prefix,
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: widget.prefixColor,
                    fontSize: 13,
                  ),
                ),
              ),
              const SizedBox(width: 14),
              // Option text (Smaller font size: 14)
              Expanded(
                child: RichText(
                  text: TextSpan(
                    style: TextStyle(
                      color: widget.theme.textColor,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                    children: [
                      TextSpan(text: widget.text),
                      if (_isHovered && !widget.isSelected && !widget.isReadOnly)
                        const WidgetSpan(
                          alignment: PlaceholderAlignment.middle,
                          child: _BlinkingCursor(),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// Blinking cursor widget
class _BlinkingCursor extends StatefulWidget {
  const _BlinkingCursor();

  @override
  State<_BlinkingCursor> createState() => _BlinkingCursorState();
}

class _BlinkingCursorState extends State<_BlinkingCursor> with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 500),
    )..addStatusListener((status) {
        if (status == AnimationStatus.completed) {
          _controller.reverse();
        } else if (status == AnimationStatus.dismissed) {
          _controller.forward();
        }
      });
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Provider.of<ThemeNotifier>(context);
    return FadeTransition(
      opacity: _controller,
      child: Text(
        ' |',
        style: TextStyle(
          color: theme.primary,
          fontWeight: FontWeight.bold,
          fontSize: 15,
        ),
      ),
    );
  }
}

```

---

## File: `flutter_quiz_app/lib/views/score_page.dart`

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api_service.dart';
import '../models/question.dart';
import '../theme_notifier.dart';

class ScorePage extends StatelessWidget {
  const ScorePage({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Provider.of<ThemeNotifier>(context);
    final arguments = ModalRoute.of(context)?.settings.arguments;

    if (arguments == null || arguments is! Map) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Navigator.pushReplacementNamed(context, '/login');
      });
      return Scaffold(
        body: Center(
          child: CircularProgressIndicator(color: theme.primary),
        ),
      );
    }

    final Map<dynamic, dynamic> result = arguments as Map;

    final double score = (result['score'] as num?)?.toDouble() ?? 0.0;
    final double maxScore = (result['maxScore'] as num?)?.toDouble() ?? 0.0;
    final int correctCount = result['correctCount'] as int? ?? 0;
    final int incorrectCount = result['incorrectCount'] as int? ?? 0;
    final String grade = result['grade'] as String? ?? 'F';
    final String quizId = result['quizId'] as String? ?? 'quiz1';
    final Map<dynamic, dynamic> userAnswersRaw = result['answers'] as Map? ?? {};
    final Map<String, int?> userAnswers = userAnswersRaw.map((k, v) => MapEntry(k.toString(), v as int?));

    final double pct = maxScore > 0 ? (score / maxScore) * 100 : 0.0;
    final int totalAnswered = correctCount + incorrectCount;
    final double accuracy = totalAnswered > 0 ? (correctCount / totalAnswered) * 100 : 0.0;

    // Tailored motivational/appreciative message based on percentage
    String feedbackMessage = '';
    IconData feedbackIcon = Icons.sentiment_satisfied;
    Color feedbackColor = theme.primary;

    if (pct >= 80.0) {
      feedbackMessage = 'Outstanding performance! Mastered assessment. Keep it up!';
      feedbackIcon = Icons.emoji_events_rounded;
      feedbackColor = Colors.greenAccent;
    } else if (pct >= 50.0) {
      feedbackMessage = 'Good effort! Solid understanding, but room to improve.';
      feedbackIcon = Icons.thumb_up_alt_rounded;
      feedbackColor = Colors.amberAccent;
    } else {
      feedbackMessage = 'Don\'t give up! Review the material and try again!';
      feedbackIcon = Icons.lightbulb_outline_rounded;
      feedbackColor = theme.accent;
    }

    // Choose grade color
    Color gradeColor = theme.primary;
    if (grade.contains('A')) {
      gradeColor = Colors.greenAccent;
    } else if (grade.contains('B') || grade.contains('C')) {
      gradeColor = Colors.amberAccent;
    } else if (grade.contains('D')) {
      gradeColor = Colors.orangeAccent;
    } else {
      gradeColor = theme.accent; // F
    }

    final screenWidth = MediaQuery.of(context).size.width;
    final isDesktop = screenWidth > 800;

    return Scaffold(
      appBar: AppBar(
        title: const Text('RAPIDHUNT Evaluation Report', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1.2)),
        backgroundColor: Colors.white.withOpacity(0.01),
        elevation: 0,
        actions: [
          IconButton(
            icon: Icon(theme.isDarkMode ? Icons.light_mode : Icons.dark_mode, color: theme.primary),
            onPressed: () => theme.toggleTheme(),
          ),
          const SizedBox(width: 16),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        child: Center(
          child: Container(
            constraints: BoxConstraints(maxWidth: isDesktop ? 920 : 460),
            padding: EdgeInsets.symmetric(
              horizontal: isDesktop ? 32.0 : 20.0,
              vertical: isDesktop ? 24.0 : 16.0,
            ),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.02),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Colors.white.withOpacity(0.08)),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.3),
                  blurRadius: 24,
                  offset: const Offset(0, 8),
                )
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Header row
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.stars_sharp, color: gradeColor, size: 28),
                    const SizedBox(width: 10),
                    Text(
                      'Quiz Completed!',
                      style: TextStyle(
                        color: theme.textColor,
                        fontSize: 20,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 1,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Center(
                  child: Text(
                    'Here is your official evaluation report.',
                    style: TextStyle(
                      color: theme.textColor.withOpacity(0.4),
                      fontSize: 12,
                    ),
                  ),
                ),
                const SizedBox(height: 16),

                // Side-by-side or stacked layout based on device
                if (isDesktop)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Left Column: Results & Buttons
                      Expanded(
                        flex: 6,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _buildCenteredScoreHighlight(score, maxScore, theme),
                            const SizedBox(height: 14),
                            _buildGradeAndFeedback(grade, gradeColor, feedbackColor, feedbackIcon, feedbackMessage, theme),
                            const SizedBox(height: 14),
                            _buildScoreDetailsBox(correctCount, incorrectCount, accuracy, theme),
                            const SizedBox(height: 16),
                            _buildControlButtons(context, theme),
                          ],
                        ),
                      ),
                      const SizedBox(width: 32),
                      // Right Column: Answer Key Table & Scoreboard
                      Expanded(
                        flex: 5,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Answer Key',
                              style: TextStyle(
                                color: theme.textColor,
                                fontWeight: FontWeight.w800,
                                fontSize: 13,
                                letterSpacing: 0.5,
                              ),
                            ),
                            const SizedBox(height: 10),
                            _buildAnswerKeyTable(quizId, userAnswers, theme),
                            _buildScoreboardTable(quizId, theme),
                          ],
                        ),
                      ),
                    ],
                  )
                else ...[
                  _buildCenteredScoreHighlight(score, maxScore, theme),
                  const SizedBox(height: 14),
                  _buildGradeAndFeedback(grade, gradeColor, feedbackColor, feedbackIcon, feedbackMessage, theme),
                  const SizedBox(height: 14),
                  _buildScoreDetailsBox(correctCount, incorrectCount, accuracy, theme),
                  const SizedBox(height: 16),
                  Text(
                    'Answer Key',
                    style: TextStyle(
                      color: theme.textColor,
                      fontWeight: FontWeight.w800,
                      fontSize: 13,
                      letterSpacing: 0.5,
                    ),
                  ),
                  const SizedBox(height: 8),
                  _buildAnswerKeyTable(quizId, userAnswers, theme),
                  _buildScoreboardTable(quizId, theme),
                  const SizedBox(height: 18),
                  _buildControlButtons(context, theme),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildCenteredScoreHighlight(double score, double maxScore, ThemeNotifier theme) {
    return Column(
      children: [
        Text(
          'TOTAL MARKS OBTAINED',
          style: TextStyle(
            color: theme.textColor.withOpacity(0.5),
            fontSize: 11,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.5,
          ),
        ),
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 16),
          decoration: BoxDecoration(
            color: theme.primary.withOpacity(0.06),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: theme.primary, width: 2),
            boxShadow: [
              BoxShadow(
                color: theme.primary.withOpacity(0.05),
                blurRadius: 12,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${score.toStringAsFixed(1).replaceAll('.0', '')} / ${maxScore.toInt()}',
                style: TextStyle(
                  color: theme.primary,
                  fontSize: 36,
                  fontWeight: FontWeight.w900,
                  fontFamily: 'monospace',
                  letterSpacing: 1.2,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'POINTS',
                style: TextStyle(
                  color: theme.textColor.withOpacity(0.6),
                  fontSize: 10,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 2.0,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildGradeAndFeedback(
    String grade,
    Color gradeColor,
    Color feedbackColor,
    IconData feedbackIcon,
    String feedbackMessage,
    ThemeNotifier theme,
  ) {
    return Row(
      children: [
        // Grade Badge
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: gradeColor.withOpacity(0.12),
            border: Border.all(color: gradeColor, width: 2.0),
            boxShadow: [
              BoxShadow(
                color: gradeColor.withOpacity(0.12),
                blurRadius: 8,
              )
            ],
          ),
          alignment: Alignment.center,
          child: Text(
            grade,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w900,
              color: gradeColor,
            ),
          ),
        ),
        const SizedBox(width: 12),
        // Dynamic Feedback Banner
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: feedbackColor.withOpacity(0.06),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: feedbackColor.withOpacity(0.15), width: 1),
            ),
            child: Row(
              children: [
                Icon(feedbackIcon, color: feedbackColor, size: 16),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    feedbackMessage,
                    style: TextStyle(
                      color: theme.textColor.withOpacity(0.9),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      height: 1.3,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildScoreDetailsBox(
    int correctCount,
    int incorrectCount,
    double accuracy,
    ThemeNotifier theme,
  ) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.black.withOpacity(0.15),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          _buildResultRow('Correct Answers', '$correctCount', theme, icon: Icons.check_circle, iconColor: Colors.greenAccent),
          const Divider(color: Colors.white12, height: 8, thickness: 1),
          _buildResultRow('Incorrect Answers', '$incorrectCount', theme, icon: Icons.cancel, iconColor: Colors.redAccent),
          const Divider(color: Colors.white12, height: 8, thickness: 1),
          _buildResultRow('Accuracy Rate', '${accuracy.toStringAsFixed(1)}%', theme, icon: Icons.insights, iconColor: Colors.cyanAccent),
        ],
      ),
    );
  }

  Widget _buildAnswerKeyTable(String quizId, Map<String, int?> userAnswers, ThemeNotifier theme) {
    return Container(
      constraints: const BoxConstraints(maxHeight: 180),
      decoration: BoxDecoration(
        border: Border.all(color: theme.textColor.withOpacity(0.06)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: FutureBuilder<List<Question>>(
        future: ApiService.getQuestions(quizId),
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(12.0),
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            );
          }
          final questions = snapshot.data ?? [];
          if (questions.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(12.0),
                child: Text('Answer key unavailable', style: TextStyle(fontSize: 11, color: Colors.grey)),
              ),
            );
          }
          return Scrollbar(
            thumbVisibility: true,
            child: SingleChildScrollView(
              child: Table(
                border: TableBorder.symmetric(
                  inside: BorderSide(color: theme.textColor.withOpacity(0.04), width: 0.5),
                ),
                columnWidths: const {
                  0: FlexColumnWidth(1.0),
                  1: FlexColumnWidth(1.2),
                  2: FlexColumnWidth(1.2),
                },
                children: [
                  TableRow(
                    decoration: BoxDecoration(
                      color: theme.textColor.withOpacity(0.02),
                      border: Border(bottom: BorderSide(color: theme.textColor.withOpacity(0.06))),
                    ),
                    children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6.0, horizontal: 8),
                        child: Text('Question No', style: TextStyle(fontWeight: FontWeight.bold, color: theme.primary, fontSize: 11)),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6.0, horizontal: 8),
                        child: Text('Correct Option', style: TextStyle(fontWeight: FontWeight.bold, color: theme.primary, fontSize: 11)),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6.0, horizontal: 8),
                        child: Text('Your Choice', style: TextStyle(fontWeight: FontWeight.bold, color: theme.primary, fontSize: 11)),
                      ),
                    ],
                  ),
                  ...questions.asMap().entries.map((entry) {
                    final idx = entry.key;
                    final q = entry.value;
                    final correctLetter = String.fromCharCode(65 + q.correctIndex);
                    
                    final givenIdx = userAnswers[q.id];
                    final String givenText;
                    final Color givenColor;
                    
                    if (givenIdx == null) {
                      givenText = '';
                      givenColor = Colors.transparent;
                    } else {
                      final givenLetter = String.fromCharCode(65 + givenIdx);
                      givenText = 'Option $givenLetter';
                      if (givenIdx == q.correctIndex) {
                        givenColor = theme.isDarkMode ? Colors.greenAccent : Colors.green;
                      } else {
                        givenColor = theme.isDarkMode ? Colors.redAccent : Colors.red;
                      }
                    }
                    
                    return TableRow(
                      children: [
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5.0, horizontal: 8),
                          child: Text('${idx + 1}', style: TextStyle(color: theme.textColor.withOpacity(0.8), fontSize: 11, fontWeight: FontWeight.w500)),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5.0, horizontal: 8),
                          child: Text('Option $correctLetter', style: const TextStyle(color: Colors.greenAccent, fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5.0, horizontal: 8),
                          child: Text(givenText, style: TextStyle(color: givenColor, fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                      ],
                    );
                  }).toList(),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildControlButtons(BuildContext context, ThemeNotifier theme) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: double.infinity,
          child: ElevatedButton.icon(
            onPressed: () {
              debugPrint('ScorePage: navigating to /student_dashboard');
              Navigator.pushNamedAndRemoveUntil(context, '/student_dashboard', (route) => false);
            },
            icon: const Icon(Icons.home_rounded, size: 14),
            label: const Text('RETURN TO HOME'),
            style: ElevatedButton.styleFrom(
              backgroundColor: theme.primary,
              foregroundColor: theme.background,
              padding: const EdgeInsets.symmetric(vertical: 12),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
              textStyle: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 0.8, fontSize: 11),
            ),
          ),
        ),
        const SizedBox(height: 8),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: () => _showSignOutDialog(context),
            icon: const Icon(Icons.logout_rounded, size: 14),
            label: const Text('SIGN OUT'),
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.accent,
              side: BorderSide(color: theme.accent, width: 1.0),
              padding: const EdgeInsets.symmetric(vertical: 12),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
              textStyle: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 0.8, fontSize: 11),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _showSignOutDialog(BuildContext context) async {
    final theme = Provider.of<ThemeNotifier>(context, listen: false);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          backgroundColor: theme.background,
          title: Text('Sign Out', style: TextStyle(color: theme.textColor, fontWeight: FontWeight.bold)),
          content: Text('Are you sure you want to sign out?', style: TextStyle(color: theme.textColor.withOpacity(0.8))),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text('CANCEL', style: TextStyle(color: theme.primary, fontWeight: FontWeight.bold)),
            ),
            ElevatedButton(
              onPressed: () => Navigator.pop(context, true),
              style: ElevatedButton.styleFrom(
                backgroundColor: theme.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              ),
              child: const Text('SIGN OUT', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ],
        );
      },
    );
    if (confirmed == true && context.mounted) {
      ApiService.currentUserEmail = '';
      ApiService.currentUserName = '';
      Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
    }
  }

  Widget _buildScoreboardTable(String quizId, ThemeNotifier theme) {
    return Container(
      margin: const EdgeInsets.only(top: 24),
      padding: const EdgeInsets.all(16.0),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.01),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.leaderboard_rounded, color: theme.primary, size: 20),
              const SizedBox(width: 8),
              Text(
                'Leaderboard Scoreboard',
                style: TextStyle(
                  color: theme.textColor,
                  fontWeight: FontWeight.w800,
                  fontSize: 14,
                  letterSpacing: 0.5,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          FutureBuilder<List<dynamic>>(
            future: ApiService.getScores(''), // Get all scores
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: Padding(
                  padding: EdgeInsets.all(24.0),
                  child: SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)),
                ));
              }
              final allScores = snapshot.data ?? [];
              // Filter scores by quizId
              final quizScores = allScores.where((s) => s['quizId'] == quizId).toList();
              
              if (quizScores.isEmpty) {
                return const Center(child: Padding(
                  padding: EdgeInsets.all(16.0),
                  child: Text('No scoreboard data available.', style: TextStyle(fontSize: 12, color: Colors.grey)),
                ));
              }

              // Sort scores: descending by score, and then by timestamp
              quizScores.sort((a, b) {
                final num scoreA = a['score'] ?? 0;
                final num scoreB = b['score'] ?? 0;
                int cmp = scoreB.compareTo(scoreA);
                if (cmp == 0) {
                  final String timeA = a['timestamp'] ?? '';
                  final String timeB = b['timestamp'] ?? '';
                  return timeA.compareTo(timeB); // Earlier timestamp gets better rank
                }
                return cmp;
              });

              // Display scoreboard as a Table
              return Table(
                border: TableBorder.symmetric(
                  inside: BorderSide(color: theme.textColor.withOpacity(0.04), width: 0.5),
                ),
                columnWidths: const {
                  0: FlexColumnWidth(0.8), // Rank
                  1: FlexColumnWidth(2.0), // User
                  2: FlexColumnWidth(1.2), // Score/Marks
                  3: FlexColumnWidth(1.0), // Grade
                },
                children: [
                  TableRow(
                    decoration: BoxDecoration(
                      color: theme.textColor.withOpacity(0.02),
                      border: Border(bottom: BorderSide(color: theme.textColor.withOpacity(0.06))),
                    ),
                    children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                        child: Text('Rank', style: TextStyle(fontWeight: FontWeight.bold, color: theme.primary, fontSize: 12)),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                        child: Text('User', style: TextStyle(fontWeight: FontWeight.bold, color: theme.primary, fontSize: 12)),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                        child: Text('Marks', style: TextStyle(fontWeight: FontWeight.bold, color: theme.primary, fontSize: 12)),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                        child: Text('Grade', style: TextStyle(fontWeight: FontWeight.bold, color: theme.primary, fontSize: 12)),
                      ),
                    ],
                  ),
                  ...quizScores.asMap().entries.map((entry) {
                    final rankIndex = entry.key;
                    final scoreDoc = entry.value;
                    final rank = rankIndex + 1;
                    
                    final String email = scoreDoc['email'] ?? '';
                    // Get name as prefix of email
                    final String username = email.contains('@') ? email.split('@')[0] : email;
                    
                    final double score = (scoreDoc['score'] as num?)?.toDouble() ?? 0.0;
                    final double maxScore = (scoreDoc['maxScore'] as num?)?.toDouble() ?? 0.0;
                    final String grade = scoreDoc['grade'] ?? 'F';
                    
                    final isCurrentUser = email == ApiService.currentUserEmail;
                    
                    Color rowTextColor = isCurrentUser ? theme.primary : theme.textColor.withOpacity(0.8);
                    FontWeight rowFontWeight = isCurrentUser ? FontWeight.bold : FontWeight.normal;
                    
                    Color gradeColor = theme.textColor.withOpacity(0.8);
                    if (grade.contains('A')) {
                      gradeColor = Colors.greenAccent;
                    } else if (grade.contains('B') || grade.contains('C')) {
                      gradeColor = Colors.amberAccent;
                    } else if (grade.contains('D')) {
                      gradeColor = Colors.orangeAccent;
                    } else {
                      gradeColor = theme.accent;
                    }
                    
                    return TableRow(
                      decoration: isCurrentUser
                          ? BoxDecoration(
                              color: theme.primary.withOpacity(0.08),
                              border: Border.all(color: theme.primary.withOpacity(0.3), width: 1),
                            )
                          : null,
                      children: [
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                          child: Text(
                            '#$rank',
                            style: TextStyle(color: rowTextColor, fontWeight: rowFontWeight, fontSize: 12),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                          child: Text(
                            username,
                            style: TextStyle(color: rowTextColor, fontWeight: rowFontWeight, fontSize: 12),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                          child: Text(
                            '${score.toStringAsFixed(1).replaceAll('.0', '')} / ${maxScore.toInt()}',
                            style: TextStyle(color: rowTextColor, fontWeight: rowFontWeight, fontSize: 12, fontFamily: 'monospace'),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 8),
                          child: Text(
                            grade,
                            style: TextStyle(color: gradeColor, fontWeight: FontWeight.bold, fontSize: 12),
                          ),
                        ),
                      ],
                    );
                  }).toList(),
                ],
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _buildResultRow(String label, String value, ThemeNotifier theme, {IconData? icon, Color? iconColor}) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Row(
          children: [
            if (icon != null) ...[
              Icon(icon, color: iconColor, size: 16),
              const SizedBox(width: 6),
            ],
            Text(
              label,
              style: TextStyle(color: theme.textColor.withOpacity(0.6), fontSize: 12, fontWeight: FontWeight.w500),
            ),
          ],
        ),
        Text(
          value,
          style: TextStyle(
            color: theme.textColor,
            fontSize: 13,
            fontWeight: FontWeight.bold,
            fontFamily: 'monospace',
          ),
        ),
      ],
    );
  }
}

```

---

## File: `flutter_quiz_app/lib/views/admin_dashboard.dart`

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:flutter_colorpicker/flutter_colorpicker.dart';
import '../api_service.dart';
import '../models/question.dart';
import '../theme_notifier.dart';

class AdminDashboard extends StatefulWidget {
  const AdminDashboard({super.key});

  @override
  State<AdminDashboard> createState() => _AdminDashboardState();
}

class _AdminDashboardState extends State<AdminDashboard> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  
  // Questions management variables
  List<Question> _questions = [];
  bool _loadingQuestions = true;
  Question? _editingQuestion;
  
  // Question Form controllers
  final _qTextController = TextEditingController();
  final _qCodeController = TextEditingController();
  final List<TextEditingController> _qOptionsControllers = List.generate(4, (_) => TextEditingController());
  int _qCorrectIndex = 0;
  final _qMarksController = TextEditingController(text: '4.0');
  final _qNegativeMarksController = TextEditingController(text: '-1.0');
  final _formKey = GlobalKey<FormState>();

  // Students management variables
  List<dynamic> _users = [];
  bool _loadingUsers = true;

  // Quizzes/Exams management variables
  List<dynamic> _quizzes = [];
  bool _loadingQuizzes = true;

  // Theme configuration variables
  Color _tempPrimaryColor = const Color(0xFF00F2FE);
  Color _tempBgColor = const Color(0xFF0D111B);
  Color _tempAccentColor = const Color(0xFFFF007F);
  String _selectedFont = 'Outfit';

  final List<String> _googleFontsList = const [
    'Outfit',
    'Inter',
    'Roboto',
    'Montserrat',
    'Poppins',
    'Open Sans',
    'Lato',
    'Oswald',
    'Playfair Display',
    'Raleway',
    'Ubuntu',
    'Nunito',
    'Lora',
    'Merriweather',
    'Fira Sans',
    'Caveat',
    'Cinzel',
  ];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _loadQuestions();
    _loadUsers();
    _loadQuizzes();
    _loadThemeFields();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _qTextController.dispose();
    _qCodeController.dispose();
    for (var controller in _qOptionsControllers) {
      controller.dispose();
    }
    _qMarksController.dispose();
    _qNegativeMarksController.dispose();
    super.dispose();
  }

  // Question CRUD Handlers
  Future<void> _loadQuestions() async {
    setState(() => _loadingQuestions = true);
    final questions = await ApiService.getQuestions();
    setState(() {
      _questions = questions;
      _loadingQuestions = false;
    });
  }

  void _clearQuestionForm() {
    setState(() {
      _editingQuestion = null;
      _qTextController.clear();
      _qCodeController.clear();
      for (var controller in _qOptionsControllers) {
        controller.clear();
      }
      _qCorrectIndex = 0;
      _qMarksController.text = '4.0';
      _qNegativeMarksController.text = '-1.0';
    });
  }

  void _editQuestion(Question q) {
    setState(() {
      _editingQuestion = q;
      _qTextController.text = q.text;
      _qCodeController.text = q.codeSnippet;
      for (int i = 0; i < 4; i++) {
        _qOptionsControllers[i].text = q.options[i];
      }
      _qCorrectIndex = q.correctIndex;
      _qMarksController.text = q.marks.toString();
      _qNegativeMarksController.text = q.negativeMarks.toString();
    });
  }

  Future<void> _saveQuestion() async {
    if (!_formKey.currentState!.validate()) return;

    final q = Question(
      id: _editingQuestion?.id ?? 'q_${DateTime.now().millisecondsSinceEpoch}',
      text: _qTextController.text.trim(),
      codeSnippet: _qCodeController.text.trim(),
      options: _qOptionsControllers.map((c) => c.text.trim()).toList(),
      correctIndex: _qCorrectIndex,
      marks: double.tryParse(_qMarksController.text) ?? 4.0,
      negativeMarks: double.tryParse(_qNegativeMarksController.text) ?? -1.0,
    );

    final success = await ApiService.saveQuestion(q);
    if (success) {
      _clearQuestionForm();
      _loadQuestions();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Question saved successfully!')),
        );
      }
    }
  }

  Future<void> _deleteQuestion(String id) async {
    final success = await ApiService.deleteQuestion(id);
    if (success) {
      _loadQuestions();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Question deleted.')),
        );
      }
    }
  }

  List<dynamic> _allScores = [];

  // Users Handlers
  Future<void> _loadUsers() async {
    setState(() => _loadingUsers = true);
    final users = await ApiService.getUsers();
    final scores = await ApiService.getScores('');
    setState(() {
      _users = users;
      _allScores = scores;
      _loadingUsers = false;
    });
  }

  Future<void> _loadQuizzes() async {
    setState(() => _loadingQuizzes = true);
    final quizzes = await ApiService.getQuizzes();
    setState(() {
      _quizzes = quizzes;
      _loadingQuizzes = false;
    });
  }

  Future<void> _showSignOutDialog() async {
    final theme = Provider.of<ThemeNotifier>(context, listen: false);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          backgroundColor: theme.background,
          title: Text('Sign Out', style: TextStyle(color: theme.textColor, fontWeight: FontWeight.bold)),
          content: Text('Are you sure you want to sign out?', style: TextStyle(color: theme.textColor.withOpacity(0.8))),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text('CANCEL', style: TextStyle(color: theme.primary, fontWeight: FontWeight.bold)),
            ),
            ElevatedButton(
              onPressed: () => Navigator.pop(context, true),
              style: ElevatedButton.styleFrom(
                backgroundColor: theme.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              ),
              child: const Text('SIGN OUT', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ],
        );
      },
    );
    if (confirmed == true && mounted) {
      ApiService.currentUserEmail = '';
      ApiService.currentUserName = '';
      Navigator.pushReplacementNamed(context, '/login');
    }
  }

  Future<void> _toggleUserApproval(String email, bool currentStatus) async {
    final success = await ApiService.approveUser(email, !currentStatus);
    if (success) {
      _loadUsers();
    }
  }

  // Theme Handlers
  void _loadThemeFields() {
    final theme = Provider.of<ThemeNotifier>(context, listen: false);
    setState(() {
      _selectedFont = theme.fontFamily;
      _tempBgColor = theme.background;
      _tempPrimaryColor = theme.primary;
      _tempAccentColor = theme.accent;
    });
  }

  void _showColorPickerDialog(String title, Color initialColor, Function(Color) onColorSelected) {
    final theme = Provider.of<ThemeNotifier>(context, listen: false);
    showDialog(
      context: context,
      builder: (context) {
        Color tempColor = initialColor;
        return AlertDialog(
          backgroundColor: theme.background,
          title: Text(title, style: TextStyle(color: theme.textColor, fontWeight: FontWeight.bold)),
          content: SingleChildScrollView(
            child: ColorPicker(
              pickerColor: tempColor,
              onColorChanged: (color) {
                tempColor = color;
              },
              pickerAreaHeightPercent: 0.8,
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('CANCEL'),
            ),
            ElevatedButton(
              onPressed: () {
                setState(() {
                  onColorSelected(tempColor);
                });
                Navigator.pop(context);
              },
              style: ElevatedButton.styleFrom(backgroundColor: theme.primary, foregroundColor: theme.background),
              child: const Text('SELECT'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _saveThemeColors() async {
    final themeNotifier = Provider.of<ThemeNotifier>(context, listen: false);
    final themeData = {
      'primary': themeNotifier.toHex(_tempPrimaryColor),
      'background': themeNotifier.toHex(_tempBgColor),
      'accent': themeNotifier.toHex(_tempAccentColor),
      'textColor': '#ffffff',
      'fontFamily': _selectedFont,
    };

    final success = await ApiService.saveTheme(themeData);
    if (success) {
      themeNotifier.updateTheme(
        primaryHex: themeData['primary']!,
        backgroundHex: themeData['background']!,
        accentHex: themeData['accent']!,
        textColorHex: themeData['textColor']!,
        fontFamily: themeData['fontFamily']!,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Theme settings updated successfully!')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Provider.of<ThemeNotifier>(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('RAPIDHUNT Admin Console', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1.5)),
        backgroundColor: Colors.white.withOpacity(0.02),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: _showSignOutDialog,
          ),
          const SizedBox(width: 16),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: theme.primary,
          labelColor: theme.primary,
          unselectedLabelColor: theme.textColor.withOpacity(0.4),
          tabs: const [
            Tab(icon: Icon(Icons.edit_note), text: 'Questions Editor'),
            Tab(icon: Icon(Icons.people_alt), text: 'Student Approvals'),
            Tab(icon: Icon(Icons.palette), text: 'Theme Settings'),
            Tab(icon: Icon(Icons.hourglass_bottom_rounded), text: 'Exam Limits'),
          ],
        ),
      ),
      body: TabBarView(
          controller: _tabController,
          children: [
            // TAB 1: Questions Configurator
            _buildQuestionsTab(theme),

            // TAB 2: Student Approvals
            _buildStudentsTab(theme),

            // TAB 3: Theme Settings
            _buildThemeTab(theme),

            // TAB 4: Global Exam Limits
            _buildExamLimitsTab(theme),
          ],
        ),
    );
  }

  Widget _buildQuestionsTab(ThemeNotifier theme) {
    return Row(
      children: [
        // Left Column: Questions List
        Expanded(
          flex: 4,
          child: Container(
            decoration: BoxDecoration(
              border: Border(right: BorderSide(color: Colors.white.withOpacity(0.08))),
            ),
            padding: const EdgeInsets.all(24.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text('Question Database', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                    IconButton(icon: const Icon(Icons.refresh), onPressed: _loadQuestions),
                  ],
                ),
                const SizedBox(height: 16),
                if (_loadingQuestions)
                  const Center(child: CircularProgressIndicator())
                else if (_questions.isEmpty)
                  const Center(child: Padding(
                    padding: EdgeInsets.all(40.0),
                    child: Text('No questions. Create one using the form on the right.'),
                  ))
                else
                  Expanded(
                    child: ListView.builder(
                      itemCount: _questions.length,
                      itemBuilder: (context, index) {
                        final q = _questions[index];
                        return Card(
                          color: Colors.white.withOpacity(0.01),
                          margin: const EdgeInsets.only(bottom: 12),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                            side: BorderSide(color: Colors.white.withOpacity(0.05)),
                          ),
                          child: ListTile(
                            title: Text(
                              'Q${index + 1}: ${q.text}',
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.bold),
                            ),
                            subtitle: Text(
                              'Marks: ${q.marks} | Neg Marks: ${q.negativeMarks}',
                              style: TextStyle(color: theme.textColor.withOpacity(0.5)),
                            ),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                IconButton(
                                  icon: Icon(Icons.edit, color: theme.primary),
                                  onPressed: () => _editQuestion(q),
                                ),
                                IconButton(
                                  icon: const Icon(Icons.delete, color: Colors.redAccent),
                                  onPressed: () => _deleteQuestion(q.id),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
        ),

        // Right Column: Add/Edit Question Form
        Expanded(
          flex: 5,
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    _editingQuestion == null ? 'Create New Question' : 'Edit Question',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 20),

                  // Question Text
                  TextFormField(
                    controller: _qTextController,
                    maxLines: 2,
                    decoration: _adminInputDecoration('Question Text', theme),
                    validator: (val) => val == null || val.trim().isEmpty ? 'Enter question text' : null,
                  ),
                  const SizedBox(height: 16),

                  // Code Snippet
                  TextFormField(
                    controller: _qCodeController,
                    maxLines: 4,
                    decoration: _adminInputDecoration('Optional Code Snippet', theme),
                    style: const TextStyle(fontFamily: 'monospace'),
                  ),
                  const SizedBox(height: 16),

                  // Options
                  ...List.generate(4, (index) {
                    final prefix = String.fromCharCode(65 + index);
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 12.0),
                      child: TextFormField(
                        controller: _qOptionsControllers[index],
                        decoration: _adminInputDecoration('Option $prefix', theme),
                        validator: (val) => val == null || val.trim().isEmpty ? 'Enter option $prefix' : null,
                      ),
                    );
                  }),
                  const SizedBox(height: 8),

                  // Correct Option & Marking Scheme
                  Row(
                    children: [
                      // Correct Index Dropdown
                      Expanded(
                        flex: 2,
                        child: DropdownButtonFormField<int>(
                          value: _qCorrectIndex,
                          decoration: _adminInputDecoration('Correct Option', theme),
                          dropdownColor: theme.background,
                          items: List.generate(4, (index) {
                            final prefix = String.fromCharCode(65 + index);
                            return DropdownMenuItem(value: index, child: Text('Option $prefix'));
                          }),
                          onChanged: (val) => setState(() => _qCorrectIndex = val ?? 0),
                        ),
                      ),
                      const SizedBox(width: 12),
                      // Marks
                      Expanded(
                        child: TextFormField(
                          controller: _qMarksController,
                          decoration: _adminInputDecoration('Marks', theme),
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          validator: (val) => val == null || double.tryParse(val) == null ? 'Must be a number' : null,
                        ),
                      ),
                      const SizedBox(width: 12),
                      // Negative Marks
                      Expanded(
                        child: TextFormField(
                          controller: _qNegativeMarksController,
                          decoration: _adminInputDecoration('Neg Marks', theme),
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          validator: (val) => val == null || double.tryParse(val) == null ? 'Must be a number' : null,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 28),

                  // Save and Clear Buttons
                  Row(
                    children: [
                      if (_editingQuestion != null) ...[
                        Expanded(
                          child: OutlinedButton(
                            onPressed: _clearQuestionForm,
                            style: OutlinedButton.styleFrom(
                              padding: const EdgeInsets.symmetric(vertical: 18),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                            ),
                            child: const Text('CANCEL'),
                          ),
                        ),
                        const SizedBox(width: 16),
                      ],
                      Expanded(
                        child: ElevatedButton(
                          onPressed: _saveQuestion,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: theme.primary,
                            foregroundColor: theme.background,
                            padding: const EdgeInsets.symmetric(vertical: 18),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                          ),
                          child: const Text('SAVE QUESTION', style: TextStyle(fontWeight: FontWeight.bold)),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildStudentsTab(ThemeNotifier theme) {
    return Container(
      padding: const EdgeInsets.all(32.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Student Authorization Queue', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              IconButton(icon: const Icon(Icons.refresh), onPressed: _loadUsers),
            ],
          ),
          const SizedBox(height: 20),
          if (_loadingUsers)
            const Center(child: CircularProgressIndicator())
          else if (_users.isEmpty)
            const Center(child: Text('No users found in database.'))
          else
            Expanded(
              child: SingleChildScrollView(
                child: DataTable(
                  columns: const [
                    DataColumn(label: Text('Display Name', style: TextStyle(fontWeight: FontWeight.bold))),
                    DataColumn(label: Text('Email Address', style: TextStyle(fontWeight: FontWeight.bold))),
                    DataColumn(label: Text('Role', style: TextStyle(fontWeight: FontWeight.bold))),
                    DataColumn(label: Text('Approval Status', style: TextStyle(fontWeight: FontWeight.bold))),
                    DataColumn(label: Text('Action', style: TextStyle(fontWeight: FontWeight.bold))),
                  ],
                  rows: _users.map<DataRow>((u) {
                    final isStudent = u['role'] == 'student';
                    final isApproved = u['approved'] == true;

                    return DataRow(
                      cells: [
                        DataCell(Text(u['displayName'] ?? '')),
                        DataCell(Text(u['email'] ?? '')),
                        DataCell(Text(
                          u['role'].toString().toUpperCase(),
                          style: TextStyle(
                            color: u['role'] == 'admin' ? theme.accent : theme.primary,
                            fontWeight: FontWeight.bold,
                            fontSize: 12,
                          ),
                        )),
                        DataCell(
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                isApproved ? Icons.verified_user : Icons.gpp_maybe,
                                color: isApproved ? Colors.greenAccent : Colors.orangeAccent,
                                size: 18,
                              ),
                              const SizedBox(width: 6),
                              Text(isApproved ? 'Authorized' : 'Pending Approval'),
                            ],
                          ),
                        ),
                        DataCell(
                          isStudent
                              ? Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    ElevatedButton(
                                      onPressed: () => _toggleUserApproval(u['email'], isApproved),
                                      style: ElevatedButton.styleFrom(
                                        backgroundColor: isApproved ? Colors.red.withOpacity(0.2) : theme.primary.withOpacity(0.2),
                                        foregroundColor: isApproved ? Colors.redAccent : theme.primary,
                                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                      ),
                                      child: Text(isApproved ? 'Revoke Auth' : 'Authorize'),
                                    ),
                                  ],
                                )
                              : const Text('N/A (System Admin)'),
                        ),
                      ],
                    );
                  }).toList(),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildThemeTab(ThemeNotifier theme) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 500),
      padding: const EdgeInsets.all(32.0),
      alignment: Alignment.topLeft,
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Dynamic Theme Configurator', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Text(
              'Changes saved here will dynamically update colors and fonts for all students taking the quiz.',
              style: TextStyle(color: theme.textColor.withOpacity(0.5), fontSize: 13),
            ),
            const SizedBox(height: 28),

            // Google Fonts Dropdown Selector
            DropdownButtonFormField<String>(
              value: _googleFontsList.contains(_selectedFont) ? _selectedFont : 'Outfit',
              decoration: _adminInputDecoration('Portal Typography (Google Font)', theme),
              dropdownColor: theme.background,
              items: _googleFontsList.map((font) {
                return DropdownMenuItem<String>(
                  value: font,
                  child: Text(font),
                );
              }).toList(),
              onChanged: (val) {
                if (val != null) {
                  setState(() => _selectedFont = val);
                }
              },
            ),
            const SizedBox(height: 20),

            // Background Color Picker Tile
            _buildColorTile('Background Color', _tempBgColor, () {
              _showColorPickerDialog('Select Background Color', _tempBgColor, (color) {
                _tempBgColor = color;
              });
            }, theme),
            const SizedBox(height: 16),

            // Primary Color Picker Tile
            _buildColorTile('Primary Neon Color', _tempPrimaryColor, () {
              _showColorPickerDialog('Select Primary Neon Color', _tempPrimaryColor, (color) {
                _tempPrimaryColor = color;
              });
            }, theme),
            const SizedBox(height: 16),

            // Accent Color Picker Tile
            _buildColorTile('Accent Color', _tempAccentColor, () {
              _showColorPickerDialog('Select Accent Color', _tempAccentColor, (color) {
                _tempAccentColor = color;
              });
            }, theme),
            const SizedBox(height: 32),

            ElevatedButton(
              onPressed: _saveThemeColors,
              style: ElevatedButton.styleFrom(
                backgroundColor: theme.primary,
                foregroundColor: theme.background,
                padding: const EdgeInsets.symmetric(vertical: 18),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              ),
              child: const Text('APPLY COLOR THEME', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildColorTile(String label, Color color, VoidCallback onTap, ThemeNotifier theme) {
    final hexString = '#${color.value.toRadixString(16).padLeft(8, '0').substring(2).toUpperCase()}';
    return Card(
      color: Colors.white.withOpacity(0.01),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(color: Colors.white.withOpacity(0.08)),
      ),
      child: ListTile(
        onTap: onTap,
        title: Text(label, style: TextStyle(color: theme.textColor, fontWeight: FontWeight.bold, fontSize: 14)),
        subtitle: Text(hexString, style: TextStyle(color: theme.textColor.withOpacity(0.5), fontFamily: 'monospace')),
        trailing: Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            border: Border.all(color: Colors.white.withOpacity(0.2), width: 1.5),
            boxShadow: [
              BoxShadow(
                color: color.withOpacity(0.2),
                blurRadius: 4,
                offset: const Offset(0, 2),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildExamLimitsTab(ThemeNotifier theme) {
    if (_loadingQuizzes) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_quizzes.isEmpty) {
      return const Center(child: Text('No exams found.'));
    }
    return Container(
      padding: const EdgeInsets.all(32.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Global Exam Attempt Limits', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              IconButton(icon: const Icon(Icons.refresh), onPressed: _loadQuizzes),
            ],
          ),
          const SizedBox(height: 20),
          Expanded(
            child: ListView.builder(
              itemCount: _quizzes.length,
              itemBuilder: (context, index) {
                final quiz = _quizzes[index];
                final String quizId = quiz['id'] ?? '';
                final String title = quiz['title'] ?? '';
                final String desc = quiz['description'] ?? '';
                final int currentLimit = quiz['attemptLimit'] ?? 1;

                return Card(
                  color: Colors.white.withOpacity(0.01),
                  margin: const EdgeInsets.only(bottom: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: BorderSide(color: Colors.white.withOpacity(0.08)),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(24.0),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(title, style: TextStyle(color: theme.textColor, fontSize: 18, fontWeight: FontWeight.bold)),
                              const SizedBox(height: 6),
                              Text(desc, style: TextStyle(color: theme.textColor.withOpacity(0.5), fontSize: 14)),
                            ],
                          ),
                        ),
                        const SizedBox(width: 24),
                        // Limit Dropdown
                        DropdownButton<int>(
                          value: currentLimit,
                          dropdownColor: theme.background,
                          items: [1, 2, 3, 5, 10, 999].map((val) {
                            return DropdownMenuItem<int>(
                              value: val,
                              child: Text(val == 999 ? 'Unlimited' : '$val attempts'),
                            );
                          }).toList(),
                          onChanged: (val) async {
                            if (val != null) {
                              final success = await ApiService.saveQuizLimitGlobal(quizId, val);
                              if (success) {
                                _loadQuizzes();
                                if (mounted) {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    SnackBar(content: Text('Attempt limit for $title updated to ${val == 999 ? "Unlimited" : val}!')),
                                  );
                                }
                              }
                            }
                          },
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  InputDecoration _adminInputDecoration(String label, ThemeNotifier theme) {
    return InputDecoration(
      labelText: label,
      labelStyle: TextStyle(color: theme.textColor.withOpacity(0.4), fontSize: 13),
      filled: true,
      fillColor: Colors.white.withOpacity(0.01),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: Colors.white.withOpacity(0.08)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: theme.primary, width: 1.5),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
    );
  }
}

```

---

