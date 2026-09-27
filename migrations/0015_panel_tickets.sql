-- The tickets that carry a signed-in person from the account host to the
-- panel host, spent once each.
--
-- With PANEL_ORIGIN set, a panel is served from an origin of its own
-- (src/panel-host.ts), which never sees the account session cookie. The
-- account host hands a signed-in owner across with a ticket: signed, bound to
-- one account and one device, good for 60 seconds. The signature is what
-- makes a ticket genuine; this table is what makes it single-use. A ticket's
-- nonce goes in here the moment the panel host accepts it, and a second
-- arrival of the same nonce finds it already present and is refused.
--
-- Nothing is written when a ticket is minted, only when one is spent, so a
-- ticket that is never used leaves no row. A row outlives its ticket only
-- until the next ticket is spent, which clears the expired ones.
--
-- Numbered 0015 because open branches already claim 0013 and 0014.

CREATE TABLE panel_tickets (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE INDEX panel_tickets_expiry ON panel_tickets (expires_at);
