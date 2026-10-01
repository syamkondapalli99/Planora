/* =========================================================
   PLANORA PUBLIC CONFIG  (planora-config.js)

   Everything in this file is PUBLIC (it ships to every browser).
   Only put values here that Supabase calls "public":
     - the Project URL
     - the anon / publishable key (safe in the browser: Row Level
       Security decides what each signed-in user can read/write)

   NEVER put here: the service_role / secret key, Google or Apple
   client secrets, Apple private keys, your OpenAI key.
   Those stay in Supabase's dashboard or in the server's .env.

   Supabase dashboard → Project Settings → API (or "Data API").
   ========================================================= */

window.PLANORA_CONFIG = {
    // e.g. "https://abcdefghijklmnop.supabase.co"
    supabaseUrl: "",

    // the anon (legacy) or publishable ("sb_publishable_…") key
    supabaseAnonKey: "",

    // The real site. Sign-in links on the live site always come back here.
    productionUrl: "https://planoraai.net",

    // Where the Node server with Ask Planora's AI runs.
    // "" = the same site (localhost while developing with `npm start`).
    // GitHub Pages can't run Node, so for planoraai.net set this to the
    // address of a hosted copy of server.js (e.g. "https://api.planoraai.net").
    apiBase: ""
};
