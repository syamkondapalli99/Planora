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
    supabaseUrl: "https://wnxevuyxoiysaeoguodb.supabase.co",

    // the anon (legacy) or publishable ("sb_publishable_…") key
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndueGV2dXl4b2l5c2Flb2d1b2RiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NTAzMTIsImV4cCI6MjEwNjQyNjMxMn0.cS7xdHypmg4DFYkqtUyTxakNQUnG5FGpLE95ue0Xe4E",

    // Google OAuth Client ID (public; NOT the client secret). Used for Google's own
    // sign-in pop-up so it says "Sign in to planoraai.net". "" = use the redirect.
    googleClientId: "452146070808-qdo45feqsutqj93d6t80lsc2k06e736b.apps.googleusercontent.com",

    // The real site. Sign-in links on the live site always come back here.
    productionUrl: "https://planoraai.net",

    // Where the Node server with Ask Planora's AI runs.
    // "" = the same site (localhost while developing with `npm start`).
    // GitHub Pages can't run Node, so for planoraai.net set this to the
    // address of a hosted copy of server.js (e.g. "https://api.planoraai.net").
    apiBase: ""
};
