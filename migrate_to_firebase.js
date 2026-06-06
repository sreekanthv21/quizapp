const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");
const dbPath = path.join(__dirname, "db.json");

if (!fs.existsSync(serviceAccountPath)) {
  console.error("serviceAccountKey.json not found!");
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error("db.json not found!");
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);
const dbData = JSON.parse(fs.readFileSync(dbPath, "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrate() {
  console.log("Starting migration to Firestore...");

  // 1. Migrate Quizzes
  if (dbData.quizzes && dbData.quizzes.length > 0) {
    console.log(`Migrating ${dbData.quizzes.length} quizzes...`);
    for (const quiz of dbData.quizzes) {
      await db.collection("quizzes").doc(quiz.id).set(quiz);
      console.log(`Uploaded quiz: ${quiz.id}`);
    }
  }

  // 2. Migrate Questions
  if (dbData.questions && dbData.questions.length > 0) {
    console.log(`Migrating ${dbData.questions.length} questions...`);
    for (const q of dbData.questions) {
      await db.collection("questions").doc(q.id).set(q);
      console.log(`Uploaded question: ${q.id}`);
    }
  }

  // 3. Migrate Theme
  if (dbData.theme && Object.keys(dbData.theme).length > 0) {
    console.log("Migrating theme settings...");
    await db.collection("settings").doc("theme").set(dbData.theme);
    console.log("Uploaded theme settings.");
  }

  console.log("Migration completed successfully!");
  process.exit(0);
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
