<%
// The needs-human comment, written for someone who has never seen the repo and
// has no code open. The block supplies the words; this file owns every piece of
// formatting — the greeting, the question numbers, the option letters, the
// dividers and the footer — so a factory restyles the comment by registering
// its own `needs-human-comment` and changes no block.
//
// The array reads are guarded because `check()` renders this file with no data
// at all, resolving every variable to a placeholder string. A real render is
// strict: the step passes every key below, and reading one it did not throws.
const questions = Array.isArray(it.QUESTIONS) ? it.QUESTIONS : [];
const notes = Array.isArray(it.NOTES) ? it.NOTES : [];
const letters = "abcdefghijklmnopqrstuvwxyz";
const footer = [`Run ${it.RUN_ID}`];
if (it.PIPELINE) footer.push(`pipeline \`${it.PIPELINE}\``);
footer.push(`paused at ${it.PAUSED_AT}`);
if (it.DASHBOARD_URL) footer.push(`[dashboard](${it.DASHBOARD_URL})`);
-%>
<% if (it.MENTIONS) { %><%= it.MENTIONS %> — <% } %><%= it.HEADLINE %>
<% if (it.ABOUT) { -%>

**What this ticket is about.** <%= it.ABOUT %>
<% } -%>

<% if (it.ON_REPLY === "retry") { -%>
Once this is fixed, reply with anything and jigs will try the step again.
<% } else { -%>
Reply to this comment with your choices, for example `1a, 2b`. Plain words or a question are fine too. Any reply wakes the run.
<% } -%>
<% questions.forEach((question, index) => { -%>

---

### <%= index + 1 %>. <%= question.question %>
<% if (question.context) { -%>

<%= question.context %>
<% } -%>
<% const options = Array.isArray(question.options) ? question.options : []; if (options.length > 0) { -%>

<% options.forEach((option, letter) => { -%>
- **<%= letters[letter] %>)** <%= option.label %><% if (option.recommended) { %> *(recommended)*<% } %>
<% }) -%>
<% } -%>
<% }) -%>
<% if (notes.length > 0) { -%>

---

<% notes.forEach((note) => { -%>
- <%= note %>
<% }) -%>
<% } -%>

---

<sub><%= footer.join(" · ") %></sub>
