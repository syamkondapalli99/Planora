/* =========================================================
   Planora feedback → info@jkssofttech.com

   Paste this into a Google Apps Script project created while signed in
   as info@jkssofttech.com (script.google.com → New project).
   1. Replace PASTE_YOUR_SECRET_HERE with the same text you put in
      Render's FEEDBACK_SECRET setting.
   2. Deploy → New deployment → type "Web app"
        Execute as:      Me (info@jkssofttech.com)
        Who has access:  Anyone
      → Deploy → allow the permissions → copy the Web app URL (ends in /exec).
   3. Put that URL in Render as FEEDBACK_WEBHOOK_URL.
   Only Planora's server knows the secret, so nobody else can use this to send you mail.
   ========================================================= */

const SECRET = "PASTE_YOUR_SECRET_HERE";
const TO = "info@jkssofttech.com";

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return reply_({ ok: false }); }
  if (!d || SECRET === "PASTE_YOUR_SECRET_HERE" || d.secret !== SECRET) return reply_({ ok: false });

  const name = String(d.name || "").slice(0, 80);
  const email = String(d.email || "").slice(0, 254);
  const message = String(d.message || "").slice(0, 4000);
  const account = d.account ? (d.account.email || d.account.id) : "Not signed in";

  const text =
    "New Planora feedback\n\n" +
    "Name: " + name + "\nEmail: " + email + "\nAccount: " + account + "\n\n" +
    message + "\n\n—\nSent " + d.sentAt + "\nPage: " + (d.page || "") + "\nDevice: " + (d.device || "");

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1E1A4D">' +
    '<h2 style="margin:0 0 12px;color:#5145CD">New Planora feedback</h2>' +
    "<p><b>Name:</b> " + esc(name) + "<br><b>Email:</b> " + esc(email) + "<br><b>Account:</b> " + esc(account) + "</p>" +
    '<div style="white-space:pre-wrap;background:#F4F1FF;border-radius:10px;padding:12px 14px">' + esc(message) + "</div>" +
    '<p style="color:#888;font-size:12px;margin-top:14px">Sent ' + esc(d.sentAt) + " · " + esc(d.page || "") + "<br>" + esc(d.device || "") + "</p>" +
    "<p style=\"color:#888;font-size:12px\">Press Reply to answer " + esc(name) + " directly.</p></div>";

  MailApp.sendEmail({
    to: TO,
    replyTo: email,
    name: "Planora feedback",
    subject: "Planora feedback from " + name,
    body: text,
    htmlBody: html
  });
  return reply_({ ok: true });
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
