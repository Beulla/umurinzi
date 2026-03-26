import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "umurinzi_dev_secret";

app.use(cors());
app.use(express.json());

const sessions = new Map();

const districts = [
  { id: 1, key: "kigali", label: "Kigali" },
  { id: 2, key: "huye", label: "Huye" },
  { id: 3, key: "musanze", label: "Musanze" },
  { id: 4, key: "rwamagana", label: "Rwamagana" }
];

const harmTypes = [
  { id: 1, key: "physical", label: "Physical abuse" },
  { id: 2, key: "sexual", label: "Sexual abuse" },
  { id: 3, key: "online", label: "Online harm" },
  { id: 4, key: "neglect", label: "Neglect" },
  { id: 5, key: "other", label: "Other" }
];

const makeSessionId = () => `S-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const makeCaseId = () => `SC-2026-${Math.floor(1000 + Math.random() * 9000)}`;

const { MONGODB_URI } = process.env;
if (!MONGODB_URI) throw new Error("MONGODB_URI is required");

const mongooseOptions = {};
if (process.env.MONGODB_DB) mongooseOptions.dbName = process.env.MONGODB_DB;
await mongoose.connect(MONGODB_URI, mongooseOptions);

const reportSchema = new mongoose.Schema(
  {
    caseId: { type: String, unique: true, index: true },
    sessionId: { type: String, index: true },
    harmType: { id: Number, key: String, label: String },
    district: { id: Number, key: String, label: String },
    districtKey: { type: String, index: true },
    districtLabel: String,
    safeNow: { type: Boolean, default: true, index: true },
    identityExposed: { type: Boolean, default: false },
    queued: { type: Boolean, default: false, index: true },
    sent: { type: Boolean, default: true, index: true },
    smsTriggered: { type: Boolean, default: true, index: true },
    sentAt: Date,
    status: { type: String, default: "New", index: true },
    priority: { type: String, default: "Medium", index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    assignedAt: Date,
    dueAt: Date,
    resolvedAt: Date,
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolutionSummary: String,
    lastActionAt: Date,
    notes: [{ text: String, userId: String, createdAt: { type: Date, default: Date.now } }]
  },
  { timestamps: true }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, index: true },
    districtKeys: { type: [String], default: [] },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const Report = mongoose.models.Report || mongoose.model("Report", reportSchema);
const User = mongoose.models.User || mongoose.model("User", userSchema);

const seedUsers = [
  { name: "Aline Uwase", email: "aline@umurinzi.rw", password: "Password123!", role: "social_worker", districtKeys: ["kigali", "rwamagana"] },
  { name: "Jean Claude", email: "jean@umurinzi.rw", password: "Password123!", role: "social_worker", districtKeys: ["huye"] },
  { name: "Claudine M.", email: "claudine@umurinzi.rw", password: "Password123!", role: "social_worker", districtKeys: ["musanze"] },
  { name: "District Supervisor", email: "supervisor@umurinzi.rw", password: "Password123!", role: "admin", districtKeys: ["kigali", "huye", "musanze", "rwamagana"] }
];

for (const seed of seedUsers) {
  const existing = await User.findOne({ email: seed.email.toLowerCase() });
  if (!existing) {
    const passwordHash = await bcrypt.hash(seed.password, 10);
    await User.create({
      name: seed.name,
      email: seed.email.toLowerCase(),
      passwordHash,
      role: seed.role,
      districtKeys: seed.districtKeys,
      active: true
    });
  }
}

const authRequired = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ _id: decoded.sub, active: true })
      .select({ name: 1, email: 1, role: 1, districtKeys: 1, active: 1 })
      .lean();
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.authUser = user;
    return next();
  } catch (_err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

const roleRequired = (roles) => (req, res, next) => {
  if (!req.authUser || !roles.includes(req.authUser.role)) return res.status(403).json({ error: "Forbidden" });
  return next();
};

const canEditCase = async (caseId, authUser) => {
  if (authUser.role === "admin") return true;
  if (authUser.role !== "social_worker") return false;
  const report = await Report.findOne({ caseId, sent: true }).select({ assignedTo: 1 }).lean();
  if (!report) return false;
  return String(report.assignedTo || "") === String(authUser._id);
};

app.get("/api/meta", (_req, res) => {
  res.json({ districts, harmTypes });
});

app.post("/api/ussd/start", (req, res) => {
  const language = req.body?.language === "rw" ? "rw" : "en";
  const sessionId = makeSessionId();
  sessions.set(sessionId, {
    language,
    state: "SAFE_CHECK",
    createdAt: new Date().toISOString(),
    safeNow: null,
    harmType: null,
    district: null
  });
  res.json({
    sessionId,
    state: "SAFE_CHECK",
    message: language === "rw" ? "Ese uri ahantu hatekanye ubu? 1=Yego 2=Oya" : "Are you safe right now? 1=Yes 2=No"
  });
});

app.post("/api/ussd/step", async (req, res) => {
  const { sessionId, input } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  if (session.state === "SAFE_CHECK") {
    if (input === "2") {
      session.safeNow = false;
      session.state = "HARM_TYPE";
      return res.json({
        state: "HARM_TYPE",
        ended: false,
        smsTriggered: true,
        message: session.language === "rw" ? "Ubutumwa bwihutirwa bwoherejwe ku buyobozi bw'akarere." : "Emergency contacts SMS has been sent to district."
      });
    }
    if (input === "1") {
      session.safeNow = true;
      session.state = "HARM_TYPE";
      return res.json({
        state: "HARM_TYPE",
        message: session.language === "rw" ? "Hitamo ubwoko bw'ihohoterwa: 1-Physical 2-Sexual 3-Online 4-Neglect 5-Other" : "Select type of harm: 1-Physical 2-Sexual 3-Online 4-Neglect 5-Other"
      });
    }
    return res.status(400).json({ error: "Invalid input for SAFE_CHECK" });
  }

  if (session.state === "HARM_TYPE") {
    const selected = harmTypes.find((h) => String(h.id) === String(input));
    if (!selected) return res.status(400).json({ error: "Invalid harm type" });
    session.harmType = selected;
    session.state = "DISTRICT";
    return res.json({
      state: "DISTRICT",
      message: session.language === "rw" ? "Hitamo akarere: 1-Kigali 2-Huye 3-Musanze 4-Rwamagana 0-Gusimbuka" : "Select district: 1-Kigali 2-Huye 3-Musanze 4-Rwamagana 0-Skip"
    });
  }

  if (session.state === "DISTRICT") {
    if (input === "0") {
      session.district = null;
    } else {
      const selected = districts.find((d) => String(d.id) === String(input));
      if (!selected) return res.status(400).json({ error: "Invalid district" });
      session.district = selected;
    }
    const caseId = makeCaseId();
    const isHighRisk = session.safeNow === false || session.harmType?.key === "sexual";
    await Report.create({
      caseId,
      sessionId,
      harmType: session.harmType,
      district: session.district,
      districtKey: session.district?.key || "unassigned",
      districtLabel: session.district?.label || "Unassigned",
      safeNow: session.safeNow === false ? false : true,
      identityExposed: false,
      queued: false,
      sent: true,
      smsTriggered: true,
      sentAt: new Date(),
      status: isHighRisk ? "Escalated" : "New",
      priority: isHighRisk ? "Critical" : "Medium",
      lastActionAt: new Date()
    });
    sessions.delete(sessionId);
    return res.json({ ended: true, queued: false, state: "DONE", caseId, message: "Alert sent to district CPWO dashboard." });
  }

  return res.status(400).json({ error: "Session is not active" });
});

app.get("/api/cases/:caseId", authRequired, async (req, res) => {
  const found = await Report.findOne({ caseId: req.params.caseId }).lean();
  if (!found) return res.status(404).json({ error: "Case not found" });
  res.json(found);
});

app.get("/api/dashboard/alerts", authRequired, roleRequired(["admin"]), async (_req, res) => {
  const queued = await Report.countDocuments({ queued: true });
  const sent = await Report.countDocuments({ sent: true });
  const reports = await Report.find({}).sort({ createdAt: -1 }).select({ caseId: 1, harmType: 1, districtKey: 1, districtLabel: 1, queued: 1, sent: 1, createdAt: 1, status: 1 }).lean();
  const alerts = {};
  for (const report of reports) {
    const key = report.districtKey || "unassigned";
    if (!alerts[key]) alerts[key] = [];
    alerts[key].push(report);
  }
  res.json({ queued, sent, alerts });
});

app.get("/api/social-worker/reports", authRequired, roleRequired(["admin"]), async (_req, res) => {
  const reports = await Report.find({ sent: true })
    .sort({ sentAt: -1, createdAt: -1 })
    .select({
      caseId: 1,
      harmType: 1,
      districtLabel: 1,
      districtKey: 1,
      safeNow: 1,
      status: 1,
      priority: 1,
      sentAt: 1,
      createdAt: 1,
      assignedAt: 1,
      dueAt: 1,
      resolvedAt: 1,
      resolutionSummary: 1
    })
    .lean();
  res.json({ reports });
});

app.get("/api/users", authRequired, roleRequired(["admin"]), async (req, res) => {
  const role = req.query.role ? String(req.query.role) : null;
  const query = role ? { role, active: true } : { active: true };
  const users = await User.find(query).select({ name: 1, email: 1, role: 1, districtKeys: 1 }).sort({ name: 1 }).lean();
  res.json({ users });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  const user = await User.findOne({ email, active: true });
  if (!user) return res.status(401).json({ error: "Invalid login" });
  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) return res.status(401).json({ error: "Invalid login" });
  const token = jwt.sign({ sub: String(user._id), role: user.role, email: user.email }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, user: { _id: user._id, name: user.name, email: user.email, role: user.role, districtKeys: user.districtKeys } });
});

app.get("/api/auth/me", authRequired, async (req, res) => {
  res.json({ user: req.authUser });
});

app.get("/api/supervisor/unassigned", authRequired, roleRequired(["admin"]), async (_req, res) => {
  const reports = await Report.find({ sent: true, $or: [{ assignedTo: null }, { status: "New" }] })
    .sort({ createdAt: -1 })
    .select({ caseId: 1, harmType: 1, districtLabel: 1, districtKey: 1, safeNow: 1, status: 1, priority: 1, createdAt: 1 })
    .lean();
  res.json({ reports });
});

app.get("/api/social-worker/my-cases", authRequired, roleRequired(["social_worker"]), async (req, res) => {
  const reports = await Report.find({ sent: true, assignedTo: req.authUser._id })
    .populate("assignedTo", "name role")
    .sort({ lastActionAt: -1, createdAt: -1 })
    .lean();
  res.json({ reports });
});

app.post("/api/cases/:caseId/assign", authRequired, roleRequired(["admin"]), async (req, res) => {
  const caseId = req.params.caseId;
  const userId = String(req.body?.userId || "");
  const priority = String(req.body?.priority || "Medium");
  const dueAt = req.body?.dueAt ? new Date(req.body.dueAt) : null;
  if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: "Valid userId is required" });
  const user = await User.findById(userId).lean();
  if (!user || user.role !== "social_worker" || !user.active) return res.status(400).json({ error: "Social worker not found" });
  const updated = await Report.findOneAndUpdate(
    { caseId, sent: true },
    { $set: { assignedTo: userId, assignedAt: new Date(), status: "Assigned", priority, dueAt, lastActionAt: new Date() } },
    { new: true }
  ).populate("assignedTo", "name role").lean();
  if (!updated) return res.status(404).json({ error: "Case not found or not sent yet" });
  res.json({ report: updated });
});

app.patch("/api/cases/:caseId/status", authRequired, roleRequired(["admin", "social_worker"]), async (req, res) => {
  const caseId = req.params.caseId;
  const status = String(req.body?.status || "");
  const allowed = ["New", "Assigned", "In Progress", "Escalated", "Resolved", "Closed"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
  if (status === "Resolved") return res.status(400).json({ error: "Use /api/cases/:caseId/resolve to resolve a case" });
  if (!(await canEditCase(caseId, req.authUser))) return res.status(403).json({ error: "Forbidden" });
  const updated = await Report.findOneAndUpdate(
    { caseId, sent: true },
    { $set: { status, lastActionAt: new Date() }, $unset: { resolvedAt: 1, resolvedBy: 1, resolutionSummary: 1 } },
    { new: true }
  ).populate("assignedTo", "name role").lean();
  if (!updated) return res.status(404).json({ error: "Case not found" });
  res.json({ report: updated });
});

app.post("/api/cases/:caseId/resolve", authRequired, roleRequired(["admin", "social_worker"]), async (req, res) => {
  const caseId = req.params.caseId;
  const summary = String(req.body?.summary || "").trim();
  if (!summary) return res.status(400).json({ error: "Resolution summary is required" });
  if (!(await canEditCase(caseId, req.authUser))) return res.status(403).json({ error: "Forbidden" });
  const now = new Date();
  const updated = await Report.findOneAndUpdate(
    { caseId, sent: true },
    {
      $set: {
        status: "Resolved",
        resolvedAt: now,
        resolvedBy: req.authUser._id,
        resolutionSummary: summary,
        lastActionAt: now
      },
      $push: {
        notes: {
          text: `Resolved: ${summary}`,
          userId: String(req.authUser._id),
          createdAt: now
        }
      }
    },
    { new: true }
  )
    .populate("assignedTo", "name role")
    .populate("resolvedBy", "name role")
    .lean();
  if (!updated) return res.status(404).json({ error: "Case not found" });
  res.json({ report: updated });
});

app.post("/api/cases/:caseId/notes", authRequired, roleRequired(["admin", "social_worker"]), async (req, res) => {
  const caseId = req.params.caseId;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  if (!(await canEditCase(caseId, req.authUser))) return res.status(403).json({ error: "Forbidden" });
  const updated = await Report.findOneAndUpdate(
    { caseId, sent: true },
    { $push: { notes: { text, userId: String(req.authUser._id), createdAt: new Date() } }, $set: { lastActionAt: new Date() } },
    { new: true }
  ).populate("assignedTo", "name role").lean();
  if (!updated) return res.status(404).json({ error: "Case not found" });
  res.json({ report: updated });
});

app.post("/api/ussd/simulate", async (req, res) => {
  const language = req.body?.language === "rw" ? "rw" : "en";
  const rawInputs = req.body?.inputs;
  if (!Array.isArray(rawInputs) || rawInputs.length === 0) return res.status(400).json({ error: "inputs must be a non-empty array" });
  const inputs = rawInputs.map((v) => String(v));

  const startRes = await fetch(`http://localhost:${port}/api/ussd/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language })
  });
  const started = await startRes.json();
  if (!startRes.ok) return res.status(startRes.status).json(started);

  const steps = [{ input: null, response: started }];
  let final = started;
  for (const input of inputs) {
    const stepRes = await fetch(`http://localhost:${port}/api/ussd/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: started.sessionId, input })
    });
    const stepData = await stepRes.json();
    steps.push({ input, response: stepData, ok: stepRes.ok, status: stepRes.status });
    final = stepData;
    if (!stepRes.ok || stepData.ended) break;
  }

  return res.json({
    sessionId: started.sessionId,
    language,
    consumedInputs: steps.filter((s) => s.input !== null).length,
    steps,
    final
  });
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
