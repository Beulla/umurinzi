import React, { useEffect, useMemo, useState } from "react";

const apiBase = "http://localhost:4000/api";
const tokenKey = "umurinzi_token";

const labels = {
  en: {
    title: "Child Help Intake",
    subtitle: "Dial *717# simulation",
    start: "Start Session",
    safePrompt: "Are you safe right now?",
    yes: "Yes",
    no: "No",
    harmTitle: "Type of harm",
    districtTitle: "District (optional)",
    skip: "Skip",
    sessionEnded: "Session complete",
    sentMsg: "Report submitted successfully",
    caseId: "Case ID"
  },
  rw: {
    title: "Ubufasha ku Mwana",
    subtitle: "Ikigereranyo cya *717#",
    start: "Tangira Session",
    safePrompt: "Ese uri ahantu hatekanye ubu?",
    yes: "Yego",
    no: "Oya",
    harmTitle: "Ubwoko bw'ihohoterwa",
    districtTitle: "Akarere (si ngombwa)",
    skip: "Simbuka",
    sessionEnded: "Session yarangiye",
    sentMsg: "Raporo yoherejwe neza",
    caseId: "Nomero y'ikirego"
  }
};

function App() {
  const [page, setPage] = useState("session");
  const [language, setLanguage] = useState("en");
  const [meta, setMeta] = useState({ harmTypes: [], districts: [] });
  const [sessionId, setSessionId] = useState("");
  const [state, setState] = useState("IDLE");
  const [caseId, setCaseId] = useState("");
  const [message, setMessage] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authUser, setAuthUser] = useState(null);
  const [token, setToken] = useState("");

  const [dashboard, setDashboard] = useState({ sent: 0, alerts: {} });
  const [socialReports, setSocialReports] = useState([]);
  const [unassignedReports, setUnassignedReports] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [myCases, setMyCases] = useState([]);

  const [statusFilter, setStatusFilter] = useState("All");
  const [districtFilter, setDistrictFilter] = useState("All");
  const [priorityByCase, setPriorityByCase] = useState({});
  const [dueByCase, setDueByCase] = useState({});
  const [assignByCase, setAssignByCase] = useState({});
  const [noteByCase, setNoteByCase] = useState({});
  const [resolutionByCase, setResolutionByCase] = useState({});

  const t = useMemo(() => labels[language], [language]);

  const api = async (path, options = {}, authToken = token) => {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(`${apiBase}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  };

  const loadMeta = async () => {
    try {
      const data = await api("/meta", {}, "");
      setMeta({
        harmTypes: Array.isArray(data?.harmTypes) ? data.harmTypes : [],
        districts: Array.isArray(data?.districts) ? data.districts : []
      });
    } catch (_err) {
      setMessage("Backend unavailable.");
    }
  };

  const loadAdminData = async () => {
    const [alertsData, reportsData, unassignedData, workersData] = await Promise.all([
      api("/dashboard/alerts"),
      api("/social-worker/reports"),
      api("/supervisor/unassigned"),
      api("/users?role=social_worker")
    ]);
    setDashboard({ sent: alertsData.sent || 0, alerts: alertsData.alerts || {} });
    setSocialReports(reportsData.reports || []);
    setUnassignedReports(unassignedData.reports || []);
    setWorkers(workersData.users || []);
  };

  const loadWorkerData = async () => {
    const data = await api("/social-worker/my-cases");
    setMyCases(data.reports || []);
  };

  const loadAuthProfile = async (authToken) => {
    try {
      const data = await api("/auth/me", {}, authToken);
      setAuthUser(data.user);
      setToken(authToken);
      if (data.user.role === "admin") {
        await loadAdminData();
      } else {
        await loadWorkerData();
      }
      setPage("dashboard");
    } catch (_err) {
      localStorage.removeItem(tokenKey);
      setAuthUser(null);
      setToken("");
    }
  };

  useEffect(() => {
    loadMeta();
    const storedToken = localStorage.getItem(tokenKey);
    if (storedToken) loadAuthProfile(storedToken);
  }, []);

  const startSession = async () => {
    try {
      const data = await api("/ussd/start", {
        method: "POST",
        body: JSON.stringify({ language })
      }, "");
      setSessionId(data.sessionId);
      setState(data.state);
      setCaseId("");
      setMessage(data.message || "");
    } catch (err) {
      setMessage(err.message);
    }
  };

  const step = async (input) => {
    try {
      const data = await api("/ussd/step", {
        method: "POST",
        body: JSON.stringify({ sessionId, input: String(input) })
      }, "");
      setMessage(data.message || "");
      if (data.caseId) setCaseId(data.caseId);
      if (data.ended) {
        setState("DONE");
        if (authUser?.role === "admin") await loadAdminData();
        if (authUser?.role === "social_worker") await loadWorkerData();
      } else {
        setState(data.state);
      }
    } catch (err) {
      setMessage(err.message);
    }
  };

  const login = async () => {
    try {
      const data = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      }, "");
      localStorage.setItem(tokenKey, data.token);
      setAuthUser(data.user);
      setToken(data.token);
      setPassword("");
      setMessage("");
      if (data.user.role === "admin") {
        await loadAdminData();
      } else {
        await loadWorkerData();
      }
      setPage("dashboard");
    } catch (err) {
      setMessage(err.message);
    }
  };

  const logout = () => {
    localStorage.removeItem(tokenKey);
    setAuthUser(null);
    setToken("");
    setPage("login");
  };

  const refreshDashboard = async () => {
    try {
      if (authUser?.role === "admin") await loadAdminData();
      if (authUser?.role === "social_worker") await loadWorkerData();
    } catch (err) {
      setMessage(err.message);
    }
  };

  const assignCase = async (caseIdValue) => {
    try {
      const userId = assignByCase[caseIdValue] || workers[0]?._id;
      if (!userId) return;
      await api(`/cases/${caseIdValue}/assign`, {
        method: "POST",
        body: JSON.stringify({
          userId,
          priority: priorityByCase[caseIdValue] || "Medium",
          dueAt: dueByCase[caseIdValue] || null
        })
      });
      await loadAdminData();
    } catch (err) {
      setMessage(err.message);
    }
  };

  const updateStatus = async (caseIdValue, newStatus) => {
    try {
      await api(`/cases/${caseIdValue}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus })
      });
      await loadWorkerData();
    } catch (err) {
      setMessage(err.message);
    }
  };

  const addNote = async (caseIdValue) => {
    try {
      const text = (noteByCase[caseIdValue] || "").trim();
      if (!text) return;
      await api(`/cases/${caseIdValue}/notes`, {
        method: "POST",
        body: JSON.stringify({ text })
      });
      setNoteByCase((prev) => ({ ...prev, [caseIdValue]: "" }));
      await loadWorkerData();
    } catch (err) {
      setMessage(err.message);
    }
  };

  const resolveCase = async (caseIdValue) => {
    try {
      const summary = (resolutionByCase[caseIdValue] || "").trim();
      if (!summary) {
        setMessage("Add a resolution summary before resolving.");
        return;
      }
      await api(`/cases/${caseIdValue}/resolve`, {
        method: "POST",
        body: JSON.stringify({ summary })
      });
      setResolutionByCase((prev) => ({ ...prev, [caseIdValue]: "" }));
      await loadWorkerData();
    } catch (err) {
      setMessage(err.message);
    }
  };

  const caseColorClass = (report) => {
    if (report.status === "Resolved" || report.status === "Closed") return "case-resolved";
    if (report.dueAt && new Date(report.dueAt).getTime() < Date.now()) return "case-overdue";
    const priority = String(report.priority || "").toLowerCase();
    if (priority === "critical" || priority === "high") return "case-high";
    return "case-medium";
  };

  const filteredMyCases = useMemo(() => {
    return myCases.filter((c) => {
      const okStatus = statusFilter === "All" || (c.status || "New") === statusFilter;
      const d = c.districtKey || "unassigned";
      const okDistrict = districtFilter === "All" || districtFilter === d;
      return okStatus && okDistrict;
    });
  }, [myCases, statusFilter, districtFilter]);

  const kpis = useMemo(() => {
    if (authUser?.role === "admin") {
      const newCount = socialReports.filter((r) => (r.status || "New") === "New").length;
      const inProgress = socialReports.filter((r) => (r.status || "") === "In Progress").length;
      return [
        { label: "Total Submitted", value: dashboard.sent || 0 },
        { label: "Unassigned", value: unassignedReports.length },
        { label: "New", value: newCount },
        { label: "In Progress", value: inProgress }
      ];
    }
    const closed = myCases.filter((c) => c.status === "Closed").length;
    const progress = myCases.filter((c) => c.status === "In Progress").length;
    return [
      { label: "My Cases", value: myCases.length },
      { label: "In Progress", value: progress },
      { label: "Closed", value: closed },
      { label: "Open", value: myCases.length - closed }
    ];
  }, [authUser, dashboard, socialReports, unassignedReports, myCases]);

  return (
    <div className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <h1>Umutekano Case Portal</h1>
            <p>Child protection intake and case workflow</p>
          </div>
          <div className="topbar-actions">
            {!authUser && (
              <>
                <button className={page === "session" ? "active" : ""} onClick={() => setPage("session")}>Start Session</button>
                <button className={page === "login" ? "active" : ""} onClick={() => setPage("login")}>Login</button>
              </>
            )}
            {authUser && (
              <>
                <button className={page === "dashboard" ? "active" : ""} onClick={() => setPage("dashboard")}>Dashboard</button>
                <button onClick={logout}>Logout</button>
              </>
            )}
          </div>
        </header>

        {page === "session" && (
          <section className="panel">
            <h2>{t.title}</h2>
            <p className="muted">{t.subtitle}</p>
            <div className="row">
              <button className={language === "rw" ? "active" : ""} onClick={() => setLanguage("rw")}>Kinyarwanda</button>
              <button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>English</button>
            </div>
            <button className="primary" onClick={startSession}>{t.start}</button>

            {state === "SAFE_CHECK" && (
              <div className="panel mt">
                <h3>{t.safePrompt}</h3>
                <div className="row">
                  <button onClick={() => step(1)}>{t.yes}</button>
                  <button onClick={() => step(2)}>{t.no}</button>
                </div>
              </div>
            )}

            {state === "HARM_TYPE" && (
              <div className="panel mt">
                <h3>{t.harmTitle}</h3>
                <div className="grid">
                  {meta.harmTypes.map((type) => (
                    <button key={type.id} onClick={() => step(type.id)}>{type.id}. {type.label}</button>
                  ))}
                </div>
              </div>
            )}

            {state === "DISTRICT" && (
              <div className="panel mt">
                <h3>{t.districtTitle}</h3>
                <div className="grid">
                  {meta.districts.map((district) => (
                    <button key={district.id} onClick={() => step(district.id)}>{district.id}. {district.label}</button>
                  ))}
                  <button onClick={() => step(0)}>0. {t.skip}</button>
                </div>
              </div>
            )}

            {state === "DONE" && (
              <div className="panel mt success">
                <h3>{t.sessionEnded}</h3>
                <p>{t.caseId}: <strong>{caseId}</strong></p>
                <p>{t.sentMsg}</p>
              </div>
            )}
          </section>
        )}

        {page === "login" && (
          <section className="panel auth-panel">
            <h2>Secure Login</h2>
            <p className="muted">Use your official portal credentials</p>
            <div className="form-col">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@umurinzi.rw" />
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" />
              <button className="primary" onClick={login}>Sign In</button>
            </div>
            <div className="credentials-box">
              <p><strong>Demo Admin:</strong> supervisor@umurinzi.rw / Password123!</p>
              <p><strong>Demo Worker:</strong> aline@umurinzi.rw / Password123!</p>
            </div>
          </section>
        )}

        {page === "dashboard" && authUser && (
          <section className="panel">
            <div className="row space-between">
              <div>
                <h2>{authUser.role === "admin" ? "Supervisor Dashboard" : "Social Worker Dashboard"}</h2>
                <p className="muted">Signed in as {authUser.name} ({authUser.email})</p>
              </div>
              <button onClick={refreshDashboard}>Refresh</button>
            </div>

            <div className="kpi-grid">
              {kpis.map((k) => (
                <div className="kpi" key={k.label}>
                  <p>{k.label}</p>
                  <h2>{k.value}</h2>
                </div>
              ))}
            </div>

            {authUser.role === "admin" && (
              <div className="board-grid">
                <div className="panel">
                  <h3>Unassigned Queue</h3>
                  <div className="cards">
                    {unassignedReports.length === 0 && <p className="muted">No unassigned cases.</p>}
                    {unassignedReports.map((report) => (
                      <div className={`case-card ${caseColorClass(report)}`} key={report.caseId}>
                        <h4>{report.caseId}</h4>
                        <p>{report.harmType?.label || "Unknown"}</p>
                        <p>{report.districtLabel || report.districtKey || "Unassigned"}</p>
                        <div className="row">
                          <select
                            value={assignByCase[report.caseId] || workers[0]?._id || ""}
                            onChange={(e) => setAssignByCase((prev) => ({ ...prev, [report.caseId]: e.target.value }))}
                          >
                            {workers.map((w) => (
                              <option key={w._id} value={w._id}>{w.name}</option>
                            ))}
                          </select>
                          <select
                            value={priorityByCase[report.caseId] || "Medium"}
                            onChange={(e) => setPriorityByCase((prev) => ({ ...prev, [report.caseId]: e.target.value }))}
                          >
                            <option value="Low">Low</option>
                            <option value="Medium">Medium</option>
                            <option value="High">High</option>
                            <option value="Critical">Critical</option>
                          </select>
                        </div>
                        <div className="row">
                          <input
                            type="datetime-local"
                            value={dueByCase[report.caseId] || ""}
                            onChange={(e) => setDueByCase((prev) => ({ ...prev, [report.caseId]: e.target.value }))}
                          />
                          <button className="primary" onClick={() => assignCase(report.caseId)}>Assign</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="panel">
                  <h3>Recent Submitted Reports</h3>
                  <div className="cards">
                    {socialReports.slice(0, 30).map((report) => (
                      <div className={`case-card ${caseColorClass(report)}`} key={report.caseId}>
                        <h4>{report.caseId}</h4>
                        <p>{report.harmType?.label || "Unknown"}</p>
                        <p>{report.districtLabel || report.districtKey || "Unassigned"}</p>
                        <p>Safe now: {report.safeNow === false ? "No" : "Yes"}</p>
                        <span className="badge">{report.status || "New"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {authUser.role === "social_worker" && (
              <>
                <div className="row">
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="All">All Status</option>
                    <option value="New">New</option>
                    <option value="Assigned">Assigned</option>
                    <option value="In Progress">In Progress</option>
                    <option value="Escalated">Escalated</option>
                    <option value="Resolved">Resolved</option>
                    <option value="Closed">Closed</option>
                  </select>
                  <select value={districtFilter} onChange={(e) => setDistrictFilter(e.target.value)}>
                    <option value="All">All Districts</option>
                    {[...new Set(myCases.map((c) => c.districtKey || "unassigned"))].map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>

                <div className="cards mt">
                  {filteredMyCases.length === 0 && <p className="muted">No cases for selected filters.</p>}
                  {filteredMyCases.map((report) => (
                    <div className={`case-card ${caseColorClass(report)}`} key={report.caseId}>
                      <h4>{report.caseId}</h4>
                      <p>{report.harmType?.label || "Unknown"}</p>
                      <p>{report.districtLabel || report.districtKey || "Unassigned"}</p>
                      <p>Safe at report time: {report.safeNow === false ? "No" : "Yes"}</p>
                      <p>Submitted: {report.sentAt ? new Date(report.sentAt).toLocaleString() : "N/A"}</p>
                      <p>Created: {report.createdAt ? new Date(report.createdAt).toLocaleString() : "N/A"}</p>
                      <p>Assigned: {report.assignedAt ? new Date(report.assignedAt).toLocaleString() : "Not assigned yet"}</p>
                      <p>Due: {report.dueAt ? new Date(report.dueAt).toLocaleString() : "No due date"}</p>
                      <p>Assigned worker: {report.assignedTo?.name || "N/A"}</p>
                      <div className="row">
                        <span className="badge">{report.priority || "Medium"}</span>
                        <select value={report.status || "New"} onChange={(e) => updateStatus(report.caseId, e.target.value)}>
                          <option value="New">New</option>
                          <option value="Assigned">Assigned</option>
                          <option value="In Progress">In Progress</option>
                          <option value="Escalated">Escalated</option>
                          <option value="Closed">Closed</option>
                        </select>
                      </div>
                      <div className="row">
                        <input
                          value={resolutionByCase[report.caseId] || ""}
                          onChange={(e) => setResolutionByCase((prev) => ({ ...prev, [report.caseId]: e.target.value }))}
                          placeholder="Resolution summary"
                        />
                        <button className="primary" onClick={() => resolveCase(report.caseId)}>
                          Resolve Case
                        </button>
                      </div>
                      {report.resolutionSummary && <p>Resolution: {report.resolutionSummary}</p>}
                      {report.resolvedAt && <p>Resolved at: {new Date(report.resolvedAt).toLocaleString()}</p>}
                      <div className="row">
                        <input
                          value={noteByCase[report.caseId] || ""}
                          onChange={(e) => setNoteByCase((prev) => ({ ...prev, [report.caseId]: e.target.value }))}
                          placeholder="Add follow-up note"
                        />
                        <button onClick={() => addNote(report.caseId)}>Add Note</button>
                      </div>
                      <div className="notes">
                        {(report.notes || []).slice().reverse().map((n, idx) => (
                          <p key={`${report.caseId}-${idx}`}>{new Date(n.createdAt).toLocaleString()} - {n.text}</p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {message && <div className="toast">{message}</div>}
      </div>
    </div>
  );
}

export default App;
