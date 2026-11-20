// Client for stuff-storage. Copy this file into your app:
//
//   import { Storage } from "./client.js";
//   const storage = new Storage();
//   if (!storage.connected) await storage.connect("https://storage.example");
//   const songs = storage.type("song");
//   await songs.save("my song", "...");
//
// The storage server is not part of the app: the user names it when
// connecting, and it is remembered in the browser's local storage.

const KEY = "stuff-storage";

// "storage.example" -> "https://storage.example"
function normalize(server) {
  server = String(server ?? "").trim();
  if (!server) throw new Error("Enter the address of your storage.");
  if (!/^https?:\/\//i.test(server)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(server);
    server = (local ? "http://" : "https://") + server;
  }
  try {
    return new URL(server).origin;
  } catch {
    throw new Error("That is not a valid address.");
  }
}

export class Storage {
  // Set by the constructor if a connect just ended without a token, for
  // example "access_denied" when the user did not allow the app. Otherwise
  // null.
  connectError = null;

  constructor() {
    this.#finishConnect();
  }

  // The storage server last connected to, or null.
  get server() {
    return localStorage.getItem(`${KEY}:server`);
  }

  get token() {
    return localStorage.getItem(`${KEY}:token`);
  }

  get connected() {
    return this.server !== null && this.token !== null;
  }

  // Sends the browser to the given storage server to sign in and approve
  // this app. The server redirects back to the current page with a token.
  // Throws if there is no storage server at that address.
  async connect(server) {
    server = normalize(server);
    try {
      const info = await (await fetch(`${server}/api/info`)).json();
      if (info.service !== "stuff-storage") throw new Error();
    } catch {
      throw new Error(`No storage found at ${server}.`);
    }
    const state = crypto.randomUUID();
    sessionStorage.setItem(`${KEY}:pending`, JSON.stringify({ state, server }));
    const back = location.origin + location.pathname + location.search;
    location.assign(
      `${server}/authorize?redirect_uri=${encodeURIComponent(back)}&state=${state}`,
    );
  }

  #finishConnect() {
    const params = new URLSearchParams(location.hash.slice(1));
    const pending = JSON.parse(sessionStorage.getItem(`${KEY}:pending`) ?? "null");
    if (!pending || params.get("state") !== pending.state) return;
    sessionStorage.removeItem(`${KEY}:pending`);
    history.replaceState(null, "", location.pathname + location.search);
    const token = params.get("token");
    if (!token) {
      this.connectError = params.get("error") ?? "no_token";
      return;
    }
    localStorage.setItem(`${KEY}:server`, pending.server);
    localStorage.setItem(`${KEY}:token`, token);
  }

  // Revokes the token on the server and forgets it. The server address is
  // kept, so that it can be offered again.
  async disconnect() {
    try {
      await this.#call("/api/token", { method: "DELETE" });
    } catch {}
    localStorage.removeItem(`${KEY}:token`);
  }

  async #call(path, opts = {}) {
    if (!this.connected) throw new Error("storage is not connected");
    const res = await fetch(this.server + path, {
      ...opts,
      headers: { ...opts.headers, Authorization: `Bearer ${this.token}` },
    });
    if (res.status === 401) localStorage.removeItem(`${KEY}:token`);
    if (!res.ok) {
      const err = new Error((await res.text()) || res.statusText);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // { user, app, used, quota }, used and quota in bytes
  async whoami() {
    return (await this.#call("/api/whoami")).json();
  }

  // All documents of this app, of every type:
  // [{ type, name, size, modified, etag }], modified is unix time in seconds
  async list() {
    return (await this.#call("/api/docs")).json();
  }

  // The documents of one type, for example storage.type("song"). The type is
  // an identifier chosen by the app (letters, digits, "-", "_", "."). Names
  // are separate per type: a song and a patch can have the same name.
  type(type) {
    const base = `/api/docs/${encodeURIComponent(type)}`;
    const path = (name) => `${base}/${encodeURIComponent(name)}`;
    return {
      // [{ type, name, size, modified, etag }]
      list: async () => (await this.#call(base)).json(),

      // { data, etag }; `as` is "text", "json", "blob" or "arrayBuffer"
      load: async (name, as = "text") => {
        const res = await this.#call(path(name));
        return { data: await res[as](), etag: res.headers.get("ETag") };
      },

      // Returns the new etag. With `ifMatch` (an etag) the save fails with
      // status 412 if the stored document has changed since. With `create`
      // it fails with 412 if the document already exists.
      save: async (name, body, { ifMatch, create } = {}) => {
        const headers = {};
        if (ifMatch) headers["If-Match"] = ifMatch;
        if (create) headers["If-None-Match"] = "*";
        const res = await this.#call(path(name), { method: "PUT", headers, body });
        return res.headers.get("ETag");
      },

      // With `ifMatch` (an etag) the removal fails with status 412 if the
      // stored document has changed since.
      remove: async (name, { ifMatch } = {}) => {
        const headers = {};
        if (ifMatch) headers["If-Match"] = ifMatch;
        await this.#call(path(name), { method: "DELETE", headers });
      },
    };
  }
}
