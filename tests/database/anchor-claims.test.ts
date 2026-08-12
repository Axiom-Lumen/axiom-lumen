import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAnchorCaseRepository } from '../../lib/db/anchor-case-repository'
import { createAnchorClaimRepository } from '../../lib/db/anchor-claim-repository'
import { queryPublicAnchorFlag } from '../../lib/db/anchor-public-read-model'
import * as schema from '../../lib/db/schema'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const describeWithDatabase = adminUrl ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
let adminPool: Pool

function databaseUrl(name: string) {
  const url = new URL(adminUrl!)
  url.pathname = `/${name}`
  return url.toString()
}

async function database() {
  const name = `axiom_claim_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  databases.push(name)
  const pool = new Pool({ connectionString: databaseUrl(name), max: 2 })
  await migrate(drizzle({ client: pool }), { migrationsFolder, migrationsSchema: 'drizzle', migrationsTable: '__axiom_lumen_migrations' })
  return { pool, client: { pool, db: drizzle({ client: pool, schema }) } }
}

describeWithDatabase('ANC-04 claimant and correction workflow', () => {
  beforeAll(() => { adminPool = new Pool({ connectionString: adminUrl, max: 1 }) })
  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    await adminPool.end()
  })

  it('claims a verified domain, versions replies, disputes a public flag, and publishes corrections safely', async () => {
    const { pool, client } = await database()
    try {
      await pool.query(`INSERT INTO networks (id, passphrase, display_name) VALUES ('public', 'pass', 'Public')`)
      await pool.query(`INSERT INTO anchors (id, network_id, name, status) VALUES ('anchor-a', 'public', 'Anchor A', 'verified')`)
      await pool.query(`
        INSERT INTO anchor_domains (id, anchor_id, domain, verified_at, verification_expires_at)
        VALUES ('domain-a', 'anchor-a', 'anchor.example', '2026-08-12T09:00:00Z', '2027-08-12T09:00:00Z')
      `)
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, anchor_id, source_class, adapter, url)
        VALUES ('source-a', 'public', 'anchor-a', 'anchor_self_reported', 'anchor', 'https://anchor.example/reserves')
      `)
      await pool.query(`
        INSERT INTO ingest_cycles (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at, completed_at)
        VALUES ('cycle-a', 'anchor_reserves', 'public:USD:GABC', 'anchor-v1', 'cycle-a', 'completed', '2026-08-12T10:00:00Z', '2026-08-12T10:00:00Z', '2026-08-12T10:00:01Z')
      `)
      await pool.query(`
        INSERT INTO discrepancies
          (id, source_id, metric, subject_key, methodology_version, named_party, severity, lifecycle_state,
           publication_state, reply_review_state, consecutive_cycles, consecutive_above_info_cycles,
           first_observed_at, last_observed_at, last_finalized_cycle_id, last_finalized_cycle_at, publication_updated_at)
        VALUES ('flag-a', 'source-a', 'anchor_reserves', 'public:USD:GABC', 'anchor-v1', true, 'warning', 'open',
          'pending_reply', 'awaiting_reply', 1, 1, '2026-08-12T10:00:01Z', '2026-08-12T10:00:01Z', 'cycle-a', '2026-08-12T10:00:01Z', '2026-08-12T10:01:00Z')
      `)
      await pool.query(`
        INSERT INTO discrepancy_events (id, discrepancy_id, cycle_id, event_type, methodology_version, payload, occurred_at)
        VALUES ('flag-event-a', 'flag-a', 'cycle-a', 'opened', 'anchor-v1', '{"deviationBand":"above_info"}', '2026-08-12T10:00:01Z')
      `)
      await pool.query(`
        INSERT INTO anchor_cases (id, anchor_id, discrepancy_id, status, opened_at, reply_due_at)
        VALUES ('case-a', 'anchor-a', 'flag-a', 'awaiting_reply', '2026-08-12T10:00:01Z', '2026-08-15T10:01:00Z')
      `)
      let now = new Date('2026-08-12T10:02:00.000Z')
      const clock = () => now
      const at = (value: string) => { now = new Date(value) }
      const verifyDomainControl = async () => ({ url: 'https://anchor.example/.well-known/stellar.toml', verifiedAt: clock().toISOString() })
      const verifyWebhookControl = async () => ({ url: 'https://anchor.example/hooks/axiom' })
      const claims = createAnchorClaimRepository(client, {
        clock, verifyDomainControl, verifyWebhookControl,
        resolveEvidenceHost: async () => ['93.184.216.34'],
        evidenceScanner: { scan: async () => ({ clean: true, engine: 'fixture' }) },
        evidenceStorage: { put: async ({ sha256 }) => `sha256/${sha256}` },
        contactSecretKeyring: { activeKeyId: 'test-key', keys: new Map([['test-key', new Uint8Array(32).fill(9)]]) },
      })
      const challenge = await claims.createChallenge({ anchorId: 'anchor-a', random: () => new Uint8Array(32).fill(1) })
      expect(challenge).toMatchObject({ domain: 'anchor.example', verificationPath: '/.well-known/stellar.toml' })
      const unverifiedClaims = createAnchorClaimRepository(client, { clock, verifyDomainControl: async () => { throw new Error('domain proof missing') } })
      at('2026-08-12T10:02:30.000Z')
      await expect(unverifiedClaims.claimAnchor({ challengeId: challenge.challengeId, token: challenge.token })).rejects.toThrow(/domain proof/)
      at('2026-08-12T10:03:00.000Z')
      const completed = await claims.claimAnchor({ challengeId: challenge.challengeId, token: challenge.token, random: () => new Uint8Array(32).fill(2) })
      at('2026-08-12T10:04:00.000Z')
      await expect(claims.claimAnchor({ challengeId: challenge.challengeId, token: challenge.token })).rejects.toThrow(/already consumed/)

      await expect(claims.registerVerifiedContact({ sessionToken: completed.sessionToken, kind: 'email', endpoint: 'ops@other.example' })).rejects.toThrow(/claimed domain/)
      const contact = await claims.registerVerifiedContact({ sessionToken: completed.sessionToken, kind: 'email', endpoint: 'ops@anchor.example' })
      expect(contact).toMatchObject({ kind: 'email' })
      await expect(claims.registerVerifiedContact({ sessionToken: completed.sessionToken, kind: 'webhook', endpoint: 'https://other.example/hook', webhookSecret: 'webhook-signing-secret' })).rejects.toThrow(/claimed domain/)
      await expect(claims.registerVerifiedContact({ sessionToken: completed.sessionToken, kind: 'webhook', endpoint: 'https://anchor.example/hooks/axiom' })).rejects.toThrow(/signing secret/)
      const webhook = await claims.registerVerifiedContact({ sessionToken: completed.sessionToken, kind: 'webhook', endpoint: 'https://anchor.example/hooks/axiom', webhookSecret: 'webhook-signing-secret' })
      expect(webhook).toMatchObject({ kind: 'webhook' })
      expect((await pool.query(`SELECT count(*)::int AS count FROM anchor_contact_secrets`)).rows[0]?.count).toBe(1)

      at('2026-08-12T10:05:00.000Z')
      await expect(claims.submitReply({
        caseId: 'case-a', sessionToken: completed.sessionToken, body: 'Unsafe evidence.',
        evidence: [{ kind: 'link', url: 'http://127.0.0.1/private' }],
      })).rejects.toThrow(/HTTPS/)
      const firstReply = await claims.submitReply({
        caseId: 'case-a', sessionToken: completed.sessionToken, body: '<b>Measured context</b>',
        evidence: [
          { kind: 'link', url: 'https://anchor.example/evidence' },
          { kind: 'upload', bytes: new TextEncoder().encode('clean evidence'), contentType: 'text/plain' },
        ],
      })
      at('2026-08-12T10:06:00.000Z')
      const secondReply = await claims.submitReply({
        caseId: 'case-a', sessionToken: completed.sessionToken, body: 'Updated measured context',
      })
      expect([firstReply.version, secondReply.version]).toEqual([1, 2])
      expect((await pool.query(`SELECT count(*)::int AS count FROM anchor_replies`)).rows[0]?.count).toBe(2)
      expect((await pool.query(`SELECT reply_review_state FROM discrepancies WHERE id = 'flag-a'`)).rows[0]?.reply_review_state).toBe('response_received')

      await pool.query(`INSERT INTO api_plans (id, name, requests_per_window, window_seconds) VALUES ('plan-a', 'Internal', 1, 60)`)
      await pool.query(`INSERT INTO api_principals (id, plan_id, display_name) VALUES ('reviewer-a', 'plan-a', 'Reviewer'), ('admin-a', 'plan-a', 'Administrator'), ('reader-a', 'plan-a', 'Reader')`)
      await pool.query(`INSERT INTO api_scopes (id, description) VALUES ('anchor:review', 'Review'), ('anchor:correct', 'Correct')`)
      await pool.query(`INSERT INTO api_principal_scopes (principal_id, scope_id) VALUES ('reviewer-a', 'anchor:review'), ('admin-a', 'anchor:correct')`)
      await createAnchorCaseRepository(client).reviewCase({ caseId: 'case-a', reviewerPrincipalId: 'reviewer-a', decision: 'approve_public', reviewedAt: '2026-08-12T10:07:00.000Z', allowNamedPartyPublication: true })

      const publicFlag = await queryPublicAnchorFlag(client, 'flag-a')
      expect(publicFlag).toMatchObject({
        flagId: 'flag-a',
        response: { body: 'Updated measured context', version: 2, evidence: [] },
      })
      expect(JSON.stringify(publicFlag)).not.toContain(completed.sessionToken)
      expect(JSON.stringify(publicFlag)).not.toContain('claimant')

      at('2026-08-12T10:08:00.000Z')
      const dispute = await claims.submitDispute({ flagId: 'flag-a', sessionToken: completed.sessionToken, body: 'The published measurement should be reviewed.' })
      expect(await claims.listDisputesForReview('reviewer-a')).toEqual([expect.objectContaining({ disputeId: dispute.disputeId })])
      expect(await claims.getDisputeForReview({ disputeId: dispute.disputeId, principalId: 'reviewer-a' })).toMatchObject({ dispute: { body: 'The published measurement should be reviewed.' } })
      await expect(claims.getDisputeForReview({ disputeId: dispute.disputeId, principalId: 'reader-a' })).rejects.toThrow(/anchor:review/)
      at('2026-08-12T10:08:30.000Z')
      await expect(claims.resolveDispute({ disputeId: dispute.disputeId, principalId: 'reader-a', decision: 'resolved' })).rejects.toThrow(/anchor:review/)
      at('2026-08-12T10:09:00.000Z')
      await claims.resolveDispute({ disputeId: dispute.disputeId, principalId: 'reviewer-a', decision: 'resolved' })
      expect(await queryPublicAnchorFlag(client, 'flag-a')).toMatchObject({ disputes: [] })

      at('2026-08-12T10:09:10.000Z')
      const publicDispute = await claims.submitDispute({ flagId: 'flag-a', sessionToken: completed.sessionToken, body: 'Publish this reviewed dispute.' })
      at('2026-08-12T10:09:20.000Z')
      await expect(claims.resolveDispute({ disputeId: publicDispute.disputeId, principalId: 'reviewer-a', decision: 'resolved', publish: true })).rejects.toThrow(/publication is disabled/)
      await claims.resolveDispute({ disputeId: publicDispute.disputeId, principalId: 'reviewer-a', decision: 'resolved', publish: true, allowNamedPartyPublication: true })
      expect(await queryPublicAnchorFlag(client, 'flag-a')).toMatchObject({ disputes: [{ id: publicDispute.disputeId, status: 'resolved' }] })

      await expect(claims.correctFlag({
        caseId: 'case-a', targetEventId: 'flag-event-a', principalId: 'reader-a', action: 'corrected',
        correctedDeviationBand: 'info', reason: 'Unauthorized correction.',
      })).rejects.toThrow(/anchor:correct/)
      const corrected = await claims.correctFlag({
        caseId: 'case-a', targetEventId: 'flag-event-a', principalId: 'admin-a', action: 'corrected',
        correctedDeviationBand: 'info', reason: 'The original deviation band was overstated.',
      })
      expect(corrected.publicationState).toBe('approved_public')
      expect(await queryPublicAnchorFlag(client, 'flag-a')).toMatchObject({ corrections: [{ replacement: { correctedDeviationBand: 'info' } }] })
      at('2026-08-12T10:10:00.000Z')
      const correction = await claims.correctFlag({
        caseId: 'case-a', targetEventId: 'flag-event-a', principalId: 'admin-a', action: 'retracted',
        reason: 'The source period was not comparable.',
      })
      expect(correction.publicationState).toBe('withheld')
      const retractedFlag = await queryPublicAnchorFlag(client, 'flag-a')
      expect(retractedFlag).toMatchObject({ publicationState: 'withheld' })
      expect(retractedFlag?.corrections).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'retracted', reason: 'The source period was not comparable.' }),
      ]))
      await expect(pool.query(`UPDATE anchor_replies SET body = 'edited' WHERE id = $1`, [firstReply.replyId])).rejects.toMatchObject({ code: '55000' })
      await expect(pool.query(`INSERT INTO anchor_evidence (id, reply_id, kind, storage_reference, content_type, byte_size, sha256, scan_status, scan_result, scanned_at) VALUES ('oversized', $1, 'upload', 'sha256/object', 'text/plain', 5000001, repeat('a', 64), 'clean', '{}', now())`, [secondReply.replyId])).rejects.toMatchObject({ code: '23514' })
      expect((await pool.query(`SELECT event_type, actor_type FROM anchor_claim_events ORDER BY occurred_at, id`)).rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ event_type: 'challenge_created', actor_type: 'system' }),
        expect.objectContaining({ event_type: 'claim_verified', actor_type: 'claimant' }),
        expect.objectContaining({ event_type: 'contact_verified', actor_type: 'claimant' }),
      ]))
      expect((await pool.query(`SELECT event_type, actor_type FROM anchor_case_events WHERE case_id = 'case-a'`)).rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ event_type: 'reply_submitted', actor_type: 'anchor' }),
        expect.objectContaining({ event_type: 'dispute_reviewed', actor_type: 'reviewer' }),
        expect.objectContaining({ event_type: 'corrected', actor_type: 'administrator' }),
      ]))
      await expect(pool.query(`UPDATE anchor_claim_events SET payload = '{}' WHERE event_type = 'claim_verified'`)).rejects.toMatchObject({ code: '55000' })

      await pool.query(`
        INSERT INTO discrepancies
          (id, source_id, metric, subject_key, methodology_version, named_party, severity, lifecycle_state,
           publication_state, reply_review_state, consecutive_cycles, consecutive_above_info_cycles,
           first_observed_at, last_observed_at, last_finalized_cycle_id, last_finalized_cycle_at, publication_updated_at)
        VALUES ('flag-private', 'source-a', 'anchor_reserves', 'public:EUR:GABC', 'anchor-v1', true, 'warning', 'open',
          'pending_reply', 'awaiting_reply', 1, 1, '2026-08-12T10:00:01Z', '2026-08-12T10:00:01Z', 'cycle-a', '2026-08-12T10:00:01Z', '2026-08-12T10:01:00Z')
      `)
      await pool.query(`INSERT INTO discrepancy_events (id, discrepancy_id, cycle_id, event_type, methodology_version, payload, occurred_at) VALUES ('flag-private-event', 'flag-private', 'cycle-a', 'opened', 'anchor-v1', '{"deviationBand":"above_info"}', '2026-08-12T10:00:01Z')`)
      await pool.query(`INSERT INTO anchor_cases (id, anchor_id, discrepancy_id, status, opened_at, reply_due_at) VALUES ('case-private', 'anchor-a', 'flag-private', 'awaiting_reply', '2026-08-12T10:00:01Z', '2026-08-12T10:09:00Z')`)
      at('2026-08-12T10:11:00.000Z')
      await expect(claims.submitReply({ caseId: 'case-private', sessionToken: completed.sessionToken, body: 'Too late.' })).rejects.toThrow(/window has expired/)
      await pool.query(`UPDATE anchor_cases SET status = 'under_review' WHERE id = 'case-private'`)
      await expect(claims.submitReply({ caseId: 'case-private', sessionToken: completed.sessionToken, body: 'Late revision.' })).rejects.toThrow(/window has expired/)
      await claims.correctFlag({ caseId: 'case-private', targetEventId: 'flag-private-event', principalId: 'admin-a', action: 'retracted', reason: 'Internal correction.' })
      expect(await queryPublicAnchorFlag(client, 'flag-private')).toBeNull()

      await pool.query(`INSERT INTO anchors (id, network_id, name, status) VALUES ('anchor-b', 'public', 'Anchor B', 'verified')`)
      await pool.query(`UPDATE anchor_cases SET anchor_id = 'anchor-b' WHERE id = 'case-private'`)
      await expect(claims.submitReply({ caseId: 'case-private', sessionToken: completed.sessionToken, body: 'Wrong anchor.' })).rejects.toThrow(/not authorized/)

      await claims.revokeContact({ sessionToken: completed.sessionToken, contactEndpointId: contact.id })
      await claims.revokeContact({ sessionToken: completed.sessionToken, contactEndpointId: webhook.id })
      expect((await pool.query(`SELECT revoked_at FROM anchor_contact_endpoints WHERE id = $1`, [contact.id])).rows[0]?.revoked_at).not.toBeNull()

      await pool.query(`
        INSERT INTO discrepancies
          (id, source_id, metric, subject_key, methodology_version, named_party, severity, lifecycle_state,
           publication_state, reply_review_state, consecutive_cycles, consecutive_above_info_cycles,
           first_observed_at, last_observed_at, last_finalized_cycle_id, last_finalized_cycle_at, publication_updated_at)
        VALUES ('flag-no-contact', 'source-a', 'anchor_reserves', 'public:GBP:GABC', 'anchor-v1', true, 'warning', 'open',
          'internal', 'not_required', 1, 1, '2026-08-12T10:00:01Z', '2026-08-12T10:00:01Z', 'cycle-a', '2026-08-12T10:00:01Z', '2026-08-12T10:01:00Z')
      `)
      await pool.query(`INSERT INTO discrepancy_events (id, discrepancy_id, cycle_id, event_type, methodology_version, payload, occurred_at) VALUES ('flag-no-contact-event', 'flag-no-contact', 'cycle-a', 'opened', 'anchor-v1', '{"deviationBand":"above_info"}', '2026-08-12T10:00:01Z')`)
      await expect(createAnchorCaseRepository(client).openEligibleCase({ discrepancyId: 'flag-no-contact', triggeringEventId: 'flag-no-contact-event', openedAt: '2026-08-12T10:12:00.000Z' })).rejects.toThrow(/verified email or webhook contact/)

      at('2026-08-13T10:03:00.000Z')
      await expect(claims.registerVerifiedContact({ sessionToken: completed.sessionToken, kind: 'email', endpoint: 'late@anchor.example' })).rejects.toThrow(/expired/)

      at('2026-08-13T10:04:00.000Z')
      const replayChallenge = await claims.createChallenge({ anchorId: 'anchor-a', random: () => new Uint8Array(32).fill(3) })
      const replayResults = await Promise.allSettled([
        claims.claimAnchor({ challengeId: replayChallenge.challengeId, token: replayChallenge.token, random: () => new Uint8Array(32).fill(4) }),
        claims.claimAnchor({ challengeId: replayChallenge.challengeId, token: replayChallenge.token, random: () => new Uint8Array(32).fill(5) }),
      ])
      expect(replayResults.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      const replacementSession = replayResults.find((result): result is PromiseFulfilledResult<typeof completed> => result.status === 'fulfilled')!.value
      expect(await claims.revokeSession({ sessionToken: replacementSession.sessionToken })).toBe(true)
      await expect(claims.registerVerifiedContact({ sessionToken: replacementSession.sessionToken, kind: 'email', endpoint: 'revoked@anchor.example' })).rejects.toThrow(/revoked/)

      at('2026-08-13T10:05:00.000Z')
      const expiringChallenge = await claims.createChallenge({ anchorId: 'anchor-a', random: () => new Uint8Array(32).fill(6) })
      at('2026-08-13T10:36:00.000Z')
      await expect(claims.claimAnchor({ challengeId: expiringChallenge.challengeId, token: expiringChallenge.token })).rejects.toThrow(/expired/)

      const suspendedChallenge = await claims.createChallenge({ anchorId: 'anchor-a', random: () => new Uint8Array(32).fill(7) })
      await pool.query(`UPDATE anchors SET status = 'suspended' WHERE id = 'anchor-a'`)
      await expect(claims.claimAnchor({ challengeId: suspendedChallenge.challengeId, token: suspendedChallenge.token })).rejects.toThrow(/invalid/)
    } finally {
      await pool.end()
    }
  })
})
