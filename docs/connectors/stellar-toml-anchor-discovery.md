# Verified SEP-1 anchor discovery

`discoverAnchor` establishes issuer attribution before any anchor-published value enters reconciliation. It
reads the issuer account from Horizon, obtains its `home_domain`, retrieves SEP-1, and requires exactly one
matching anchored `[[CURRENCIES]]` record.

The connector extracts organization metadata, same-domain email contacts, and `attestation_of_reserve`. It does
not implement domain claims, challenge tokens, notifications, or public profiles; those belong to ANC-03/04.

DNS results are checked immediately before retrieval, every resolved address must be public, and the HTTPS
connection is pinned to that validated address set while retaining hostname-based TLS verification. Responses are
limited while streaming. Successful results retain account and SEP-1 content hashes, network identity, verification
time, and a 24-hour expiry in an append-only verification event. The anchor repository atomically supersedes a
rotated evidence URL. Failed re-verification suspends the registered anchor and disables its affected reserve route.

Same-domain email addresses from SEP-1 are stored as discovered contacts, not verified contacts. Contact
verification belongs to ANC-04.
