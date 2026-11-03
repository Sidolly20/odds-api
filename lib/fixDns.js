// lib/fixDns.js — fixes a common Node.js/Windows issue where "fetch failed"
// happens even though the site is reachable. Node sometimes tries IPv6
// first, and many networks (including mobile/ISP networks in Nigeria)
// don't handle that well. Forcing IPv4 first fixes it.

require('dns').setDefaultResultOrder('ipv4first');
