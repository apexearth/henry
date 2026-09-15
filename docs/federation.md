# Federation: sessions on other machines

Every machine runs the full pair (sessiond + daemon): hooks, git and transcripts are local
files, so a daemon cannot be remote. What crosses machines is a **link between daemons**,
never a window talking to a far daemon: the UI keeps its one WebSocket, and no credential
ever reaches a browser. The daemon a window is attached to dials each paired peer, mirrors
the peer's sessions into the state it already serves (tagged `peer`, with their repos,
flags, usage and playbook), and relays terminal traffic, `session:create`, kill, diffs and
the `/api/*` calls those sessions need (`?peer=` or a relayed `sessionId` routes a request
to the peer's copy of the same handler). A dropped link takes its sessions out of the rail
until it is back. Two machines that both listen dial each other, so each window sees both.

- **Listening is tailnet-only by default.** `federation.listen: "tailscale"` binds the
  machine's 100.64/10 address on `federation.port` (14712) and serves nothing but `/fed`:
  no UI, no `/api`, no hooks. `"off"` never listens; an explicit address binds that
  (`0.0.0.0` works, with a warning). Loopback :14711 is unchanged. The address is
  re-resolved every 30s and on config reload, and the listener rebinds when it moves: a
  tailnet switch or re-login changes the 100.x address, and a socket bound to the old one
  stays open but unreachable. A bind that fails (the port held by another daemon on the
  machine) is retried on a doubling wait up to 10 min and logged once per reason, and
  `HENRY_NO_PUBLIC_LISTENERS` keeps a throwaway daemon off the tailnet address here as it
  does for the phone listener.
- **Identity is a per-machine Ed25519 key** in `~/.henry/federation.json` (0600), next
  to the peer list. Pairing pins the other side's key; from then on every connection is
  mutually authenticated: an X25519 ephemeral exchange, HKDF, AES-256-GCM per direction
  with strict counters (replay = out of order = drop), and both sides sign the full
  transcript (nonces, ephemeral keys, identity keys), so a swapped key fails verification
  and the wire is private even off the tailnet.
- **Pairing is a one-time code.** "Show a pairing code" (remotes menu, or `henry pair`)
  opens a ten-minute window with a 60-bit code; the joiner proves it under the shared
  secret (a passive observer learns nothing; an active one gets five online guesses, then
  the code is revoked), and the listener proves it back under its own role, so a daemon at
  a mistyped address, or a man in the middle on an open interface, cannot accept a pairing
  and get its key pinned. The joiner also advertises its own listen URL, so one pairing
  links both ways. Both sides show fingerprints to compare afterwards. Five failed
  handshakes from one address lock it out for a minute.
- **A paired machine is you.** It can attach, type, start and kill sessions and read files
  in repos there, exactly what a window can. Pause or forget a peer from the remotes menu
  (`henry peers forget <name>`); a forgotten key is refused at the next handshake. A peer
  whose address or port changed is re-pointed in place (menu "address", `henry peers url
  <name> <host[:port]>`): the URL is just where to dial, the pinned key is the identity.
  `/api/federation/*` is never proxied and never served to a peer.
- **A peer is sent this daemon's rows; a window is sent every row it shows.** The two
  audiences want opposite halves of the same update, and a message that carries the wrong
  one is not merely thin: a window replaces its usage table wholesale, so a local-only
  `usage:update` blanks the context of every federated session until that peer speaks
  again. `broadcast` therefore merges peer rows into what goes to windows and leaves what
  goes over the link alone. A row on its own (`usage:session`) names its session and needs
  no merging; a link stores it and passes it through. The snapshot's flags and playbook are
  capped after the merge, so a window's first frame is one cap's worth, not one per machine.
- **Trust is not transitive.** A peer sees and drives this daemon's own sessions only.
  Messages from a peer that name a session relayed from another peer, or ask to create one
  there, are dropped: reaching that machine takes its own pairing.
- **In the rail** a peer's sessions sit under their own delimiter (its name, coloured like a
  repo name, on a dotted rule) below this machine's, whatever the grouping; "+ new" offers
  the connected machines as a place to start the session. **The delimiter folds**: clicking it
  hides that machine's rows (the header keeps its count, so it can be unfolded) and takes them
  out of ⌘1..9 / ⌘↑↓. Folding is a view choice, persisted per browser; the link stays up and
  the sessions keep running. File peeks and ⌘K read from the machine of the
  session you are looking at. The global playbook stays per machine.
- **Every machine's 5h/7d windows are shown, never added up.** A daemon meters the
  subscription it is signed in to and only that one, so one pair of bars was one machine's
  answer standing in for the rail's. `mergeUsage` therefore builds a `hosts` table — this
  machine under its own name, each connected peer under theirs — for windows only; what
  goes over a link is still this daemon's own pair, so a peer names us in its own merge and
  trust stays non-transitive. The strip leads with the machine of the session you are
  looking at, the Usage tab lists them all. Sharing an account means the numbers agree,
  which is a thing you can see rather than something Henry has to assume.
