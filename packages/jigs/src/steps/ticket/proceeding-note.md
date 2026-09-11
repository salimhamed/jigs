<%
// The non-blocking note jigs posts when a ticket review proceeds on stated
// assumptions. It asks for nothing: the run is already implementing, and this
// says plainly where a correction still lands.
const assumptions = Array.isArray(it.ASSUMPTIONS) ? it.ASSUMPTIONS : [];
-%>
<% if (it.MENTIONS) { %><%= it.MENTIONS %> — <% } %>jigs is starting work on <%= it.IDENTIFIER %>. Before writing code, the reviewer read the ticket and is going ahead on these assumptions:

<% assumptions.forEach((assumption) => { -%>
- <%= assumption %>
<% }) -%>

If one of these is wrong, reply here now, or comment on the pull request when it opens. Once the builder starts, a reply on this ticket is not read again until the pull request's review threads.
