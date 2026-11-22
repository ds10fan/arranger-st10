// Client for stuff-storage. Copy this file into your app:
//
//   import { Storage } from "./client.js";
//   const storage = new Storage({ types: ["song", "patch"] });
//   if (!storage.connected) await storage.connect("https://storage.example");
//   const songs = storage.type("song");
//   await songs.save("my song", "...");
//
// The storage server is not part of the app: the user names it when
// connecting, and it is remembered in the browser's local storage.
//
// The app declares the document types it works with. The user allows the
// app to read and change their documents of these types; the documents are
// shared with every other app the user allowed the same type.

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

  // The document types this app works with.
  types;

  constructor({ types } = {}) {
    if (!Array.isArray(types) || types.length === 0) {
      throw new Error("Storage needs the document types of the app: new Storage({ types: [...] })");
    }
    this.types = [...types];
    this.#finishConnect();
  }

  // The storage server last connected to, or null.
  get server() {
    return localStorage.getItem(`${KEY}:server`);
  }

  get token() {
    return localStorage.getItem(`${KEY}:token`);
  }

  // Whether there is a token that gives access to all types of this app.
  // False also when the token was issued for fewer types, for example
  // before the app started to use a new type; then connect again.
  get connected() {
    if (this.server === null || this.token === null) return false;
    let granted = [];
    try {
      granted = JSON.parse(localStorage.getItem(`${KEY}:types`) ?? "[]");
    } catch {}
    return this.types.every((type) => granted.includes(type));
  }

  // Sends the browser to the given storage server to sign in and approve
  // this app for its document types. The server redirects back to the
  // current page with a token.
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
    sessionStorage.setItem(`${KEY}:pending`, JSON.stringify({ state, server, types: this.types }));
    const back = location.origin + location.pathname + location.search;
    location.assign(
      `${server}/authorize?redirect_uri=${encodeURIComponent(back)}&state=${state}` +
        `&types=${encodeURIComponent(this.types.join(","))}`,
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
    this.#revoke(); // a token from an earlier connect, if any
    localStorage.setItem(`${KEY}:server`, pending.server);
    localStorage.setItem(`${KEY}:token`, token);
    localStorage.setItem(`${KEY}:types`, JSON.stringify(pending.types ?? []));
  }

  // Asks the server to revoke the current token, without waiting for it.
  #revoke() {
    const { server, token } = this;
    if (server === null || token === null) return;
    fetch(`${server}/api/token`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    }).catch(() => {});
  }

  // Revokes the token on the server and forgets it. The server address is
  // kept, so that it can be offered again.
  async disconnect() {
    this.#revoke();
    localStorage.removeItem(`${KEY}:token`);
  }

  async #call(path, opts = {}) {
    if (!this.connected) throw new Error("storage is not connected");
    // Captured here so that a 401 for a replaced token does not remove the new one.
    const token = this.token;
    const res = await fetch(this.server + path, {
      ...opts,
      headers: { ...opts.headers, Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && this.token === token) localStorage.removeItem(`${KEY}:token`);
    if (!res.ok) {
      const err = new Error((await res.text()) || res.statusText);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // { user, app, types, used, quota }, used and quota in bytes
  async whoami() {
    return (await this.#call("/api/whoami")).json();
  }

  // All documents of the types this app was allowed:
  // [{ type, name, size, modified, etag }], modified is unix time in seconds
  async list() {
    return (await this.#call("/api/docs")).json();
  }

  // The documents of one type, for example storage.type("song"). The type
  // must be one of those given to the constructor. It is an identifier
  // (letters, digits, "-", "_", "."); apps that should share documents use
  // the same one. Names are separate per type: a song and a patch can have
  // the same name.
  type(type) {
    if (!this.types.includes(type)) {
      throw new Error(`type "${type}" is not among the types given to Storage`);
    }
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
