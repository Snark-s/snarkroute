import { useEffect, useState } from "react";
import { ChevronLeft, KeyRound, Lock, RefreshCw } from "lucide-react";
import { DEFAULT_APP_CAPABILITIES, apiBase, isProductionBuild } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";
import { navigate } from "../../shared/navigation";
import { AdminPanel } from "./AdminPanel";
import type { AdminOverview, AppCapabilities, CurrentUser } from "../../studioTypes";

export function AdminDashboard() {
  const [capabilities, setCapabilities] = useState<AppCapabilities>(DEFAULT_APP_CAPABILITIES);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [devIdentity, setDevIdentity] = useState<"guest" | "user" | "admin">("guest");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    await loadCapabilitiesForAdmin();
    const user = await loadCurrentUserForAdmin();
    if (user?.role === "admin") await loadOverview();
    else setOverview(null);
  }

  async function loadCapabilitiesForAdmin() {
    try {
      const response = await apiFetch(`${apiBase}/api/capabilities`);
      const result = await response.json();
      if (response.ok) setCapabilities({ ...DEFAULT_APP_CAPABILITIES, ...result });
    } catch {
      setCapabilities(DEFAULT_APP_CAPABILITIES);
    }
  }

  async function loadCurrentUserForAdmin(): Promise<CurrentUser | null> {
    try {
      const response = await apiFetch(`${apiBase}/api/auth/current`);
      const result = await response.json();
      const user = response.ok ? result.user ?? null : null;
      setCurrentUser(user);
      setDevIdentity(user?.role === "admin" ? "admin" : user ? "user" : "guest");
      return user;
    } catch {
      setCurrentUser(null);
      setDevIdentity("guest");
      return null;
    }
  }

  async function loadOverview() {
    try {
      const response = await apiFetch(`${apiBase}/api/admin/overview`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Admin overview unavailable.");
      setOverview(result as AdminOverview);
      setMessage("");
    } catch (error) {
      setOverview(null);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function switchIdentity(identity: "guest" | "user" | "admin") {
    try {
      const response = await apiFetch(`${apiBase}/api/dev/switch-identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Dev identity switch unavailable.");
      setDevIdentity(identity);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const isAdmin = currentUser?.role === "admin";

  return (
    <main className="adminRoute">
      <header className="adminRouteHeader">
        <div>
          <h1><img src="/boojumroute-icon.png" alt="" /> Boojum Admin</h1>
          <p>{currentUser ? `Current user: ${currentUser.id} / ${currentUser.role ?? "user"}` : "Login required."}</p>
        </div>
        <div className="adminRouteActions">
          <button type="button" onClick={() => navigate("/")}><ChevronLeft size={16} /> Canvas</button>
          {capabilities.supportsDeveloperDiagnostics && !isProductionBuild ? <DevIdentitySwitcher identity={devIdentity} onSwitch={switchIdentity} /> : null}
          {isAdmin ? <button type="button" onClick={() => void refresh()}><RefreshCw size={16} /> Refresh</button> : null}
        </div>
      </header>
      {isAdmin ? (
        <AdminPanel overview={overview} message={message} onRefresh={() => void loadOverview()} currentUser={currentUser} standalone />
      ) : (
        <section className="accessDeniedPanel">
          <h2>{currentUser ? "Access denied" : "Login required"}</h2>
          <p>{currentUser ? "Admin role is required to open this dashboard." : "Sign in as an admin to open this dashboard."}</p>
          <button type="button" onClick={() => navigate("/admin/login")}><KeyRound size={16} /> Admin login</button>
          {message ? <p className="errorText">{message}</p> : null}
        </section>
      )}
    </main>
  );
}

export function AdminLoginPage() {
  const [capabilities, setCapabilities] = useState<AppCapabilities>(DEFAULT_APP_CAPABILITIES);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [devIdentity, setDevIdentity] = useState<"guest" | "user" | "admin">("guest");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      const capabilitiesResponse = await apiFetch(`${apiBase}/api/capabilities`);
      const capabilitiesResult = await capabilitiesResponse.json();
      if (capabilitiesResponse.ok) setCapabilities({ ...DEFAULT_APP_CAPABILITIES, ...capabilitiesResult });
    } catch {
      setCapabilities(DEFAULT_APP_CAPABILITIES);
    }
    try {
      const userResponse = await apiFetch(`${apiBase}/api/auth/current`);
      const userResult = await userResponse.json();
      const user = userResponse.ok ? userResult.user ?? null : null;
      setCurrentUser(user);
      setDevIdentity(user?.role === "admin" ? "admin" : user ? "user" : "guest");
    } catch {
      setCurrentUser(null);
      setDevIdentity("guest");
    }
  }

  async function switchIdentity(identity: "guest" | "user" | "admin") {
    try {
      const response = await apiFetch(`${apiBase}/api/dev/switch-identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Dev identity switch unavailable.");
      setDevIdentity(identity);
      await refresh();
      if (identity === "admin") navigate("/admin");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="adminRoute">
      <header className="adminRouteHeader">
        <div>
          <h1><img src="/boojumroute-icon.png" alt="" /> Admin Login</h1>
          <p>{currentUser ? `Current user: ${currentUser.id} / ${currentUser.role ?? "user"}` : "No admin session."}</p>
        </div>
        <div className="adminRouteActions">
          <button type="button" onClick={() => navigate("/")}><ChevronLeft size={16} /> Canvas</button>
          <button type="button" onClick={() => navigate("/admin")}><Lock size={16} /> Admin</button>
        </div>
      </header>
      <section className="accessDeniedPanel">
        {capabilities.supportsDeveloperDiagnostics && !isProductionBuild ? (
          <>
            <h2>Development identity</h2>
            <p className="muted">Choose Admin to open the dashboard in this browser window.</p>
            <DevIdentitySwitcher identity={devIdentity} onSwitch={switchIdentity} />
          </>
        ) : (
          <>
            <h2>Admin sign in</h2>
            <p className="muted">Sign in with an account that has the admin role.</p>
            <div className="settingsActions">
              <button type="button" onClick={() => startOAuthLogin("google")}><KeyRound size={16} /> Войти через Google</button>
              <button type="button" onClick={() => startOAuthLogin("yandex")}><KeyRound size={16} /> Войти через Яндекс</button>
            </div>
          </>
        )}
        {message ? <p className="errorText">{message}</p> : null}
      </section>
    </main>
  );
}

export function LoginPage() {
  return (
    <main className="adminRoute">
      <header className="adminRouteHeader">
        <div>
          <h1><img src="/boojumroute-icon.png" alt="" /> Boojum Login</h1>
          <p>Sign in to save routes and keep generated results.</p>
        </div>
        <button type="button" onClick={() => navigate("/")}><ChevronLeft size={16} /> Canvas</button>
      </header>
      <section className="accessDeniedPanel">
        <h2>Sign in</h2>
        <div className="settingsActions">
          <button type="button" onClick={() => startOAuthLogin("google")}><KeyRound size={16} /> Войти через Google</button>
          <button type="button" onClick={() => startOAuthLogin("yandex")}><KeyRound size={16} /> Войти через Яндекс</button>
        </div>
      </section>
    </main>
  );
}

function startOAuthLogin(provider: "google" | "yandex") {
  window.location.href = `${apiBase}/api/auth/${provider}/start`;
}

function DevIdentitySwitcher({ identity, onSwitch }: { identity: "guest" | "user" | "admin"; onSwitch: (identity: "guest" | "user" | "admin") => void }) {
  return (
    <div className="devIdentitySwitcher" title="Dev identity is stored per browser in a cookie.">
      <span>Dev identity</span>
      {(["guest", "user", "admin"] as const).map((entry) => (
        <button
          key={entry}
          className={identity === entry ? "active" : ""}
          type="button"
          onClick={() => onSwitch(entry)}
        >
          {entry[0].toUpperCase() + entry.slice(1)}
        </button>
      ))}
    </div>
  );
}