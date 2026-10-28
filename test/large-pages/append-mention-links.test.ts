/**
 * #7122: a remote append_page links the existing pages its appended text mentions, reading only that text.
 *
 * 1. Protects: a remote append to the compiled truth queues a `links` effect scoped to the bytes it added
 *    (`data.range`); the effect reads those bytes alone through the segmented reader with the writer's audience
 *    (readSegmentTexts spy: the same bounded segment text after a 10 KB append to a 1.5 MB and a 6 MB page), and adds
 *    a plain `mentions` edge (link_source mcp-remote-mention) to each mentioned page that exists and the writer can
 *    see inside its grant. It never removes an edge an earlier write made, and two appends whose effects run after
 *    both still link both. A mention of a private page or a page outside the grant makes no edge, and appended text
 *    that lands in a takes fence left open at the tail is not mined, on segmented and inline pages.
 * 2. Fails when: append_page queues no links effect (the base: no edge at all), the effect re-reads the whole page
 *    (the segment bound fails), reads the trusted text for a remote writer (the takes mention links), or reconciles
 *    the page against the appended text alone (the earlier edge is removed).
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Work is counted, never timed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { runLinksEffect } from '../../src/core/persistence/effect-links.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';
import { declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from '../../src/core/persistence/protocol.ts';

const SMALL = 'notes/mention-log-small';
const BIG = 'notes/mention-log-big';
const INLINE = 'notes/mention-log-inline';
const TAKES_SEGMENTED = 'notes/mention-log-takes';
const TAKES_INLINE = 'notes/mention-log-takes-inline';
const FENCED_LATER = 'notes/mention-log-fenced-later';
const BUSY = 'notes/mention-log-busy';
const BUSY_INLINE = 'notes/mention-log-busy-inline';
const NORMALIZED = 'notes/mention-log-normalized';
/** A takes fence in the two-dash marker form Tier 1 rewrites to the canonical one (one byte more per marker). */
const TWO_DASH_TAKES = '\n\n## Takes\n\n<!-- gbrain:takes:begin -->\n\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | Widgets will sell | take | brain | 0.5 | 2026-07 | notes |\n<!-- gbrain:takes:end -->\n\nTail paragraph.';
/** About 10 KB of conversation turns, then the mentions. */
const filler = conversationBody(10_000, { seed: 7 });
const mentions = (...slugs: string[]) => `${filler}\n\nFollow-up with ${slugs.map(slug => `[[${slug}]]`).join(', ')}.`;
const TAKES_BEGIN = '<!--- gbrain:takes:begin -->';
/** A takes block whose first begin marker never pairs (a second begin follows): the tail is protected to the end of the truth. */
const OPEN_TAKES = `\n\n${TAKES_BEGIN}\nPrivate musing.\n\n${TAKES_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | Widgets will sell | take | brain | 0.5 | 2026-07 | notes |\n<!--- gbrain:takes:end -->\n\nMore private musing.\n`;
/** A line as long as the takes begin marker, which a later trusted edit turns into one without moving any byte after it. */
const PLACEHOLDER = 'x'.repeat(TAKES_BEGIN.length);
/** Appends the busy-page seam lands at most, across the effects it delays. */
const BUSY_LANDINGS = 5;

for (const kind of testBackends()) {
  describe(`remote append_page mention links (${kind})`, () => {
    let brain: AppendBrain;
    const edges = async (slug: string) => (await brain.engine.executeRaw<{ to_slug: string; link_type: string; link_source: string }>(
      `SELECT t.slug AS to_slug, l.link_type, l.link_source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE f.source_id='default' AND f.slug=$1 ORDER BY t.slug, l.link_source`, [slug]));
    /** This producer's edges only: a trusted local write links its own text through the markdown producer. */
    const remoteEdges = async (slug: string) => (await edges(slug)).filter(e => e.link_source === 'mcp-remote-mention');
    const mention = (to_slug: string) => ({ to_slug, link_type: 'mentions', link_source: 'mcp-remote-mention' });
    const linksEffects = (slug: string) => brain.engine.executeRaw<{ request_id: string; state: string; outcome: Record<string, any> | null; data: Record<string, any> }>(
      `SELECT request_id::text AS request_id, state, outcome, data FROM persistence_effects WHERE kind='links' AND data->>'slug'=$1 ORDER BY id`, [slug]);
    /** Effects queued while `fn` runs wait until released, so the test decides when the links effects run. */
    const deferred = async <T>(fn: () => Promise<T>): Promise<T> => {
      await brain.engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
      try { return await fn(); } finally { await brain.engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()'); }
    };
    /** Release the page's links effects (and only those) and wait until each settles; returns the segment text loaded meanwhile. */
    const runLinks = async (slug: string) => {
      const original = brain.engine.readSegmentTexts;
      const loaded = { segments: 0, bytes: 0 };
      // Unbound, so a transaction engine (which inherits this property) still reads through its own transaction.
      brain.engine.readSegmentTexts = (async function (this: AppendBrain['engine'], sourceId: string, hashes: Uint8Array[]) {
        const texts = await original.call(this, sourceId, hashes);
        loaded.segments += texts.size;
        for (const text of texts.values()) loaded.bytes += text.length;
        return texts;
      }) as typeof brain.engine.readSegmentTexts;
      try {
        await brain.engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='links' AND data->>'slug'=$1 AND state='queued'", [slug]);
        await waitFor(async () => (await linksEffects(slug)).every(e => e.state === 'committed'), { timeoutMs: 60_000, intervalMs: 50, label: `links effects of ${slug} settled` });
      } finally { brain.engine.readSegmentTexts = original; }
      return loaded;
    };
    const append = async (slug: string, text: string, extra: Record<string, unknown> = {}) => {
      const res = await brain.call('append_page', { slug, text, request_id: randomUUID(), ...extra }, { remote: true });
      expect(res).toMatchObject({ isError: false });
      return res.body;
    };

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      for (const slug of ['notes/alice-example', 'notes/bob-example', 'notes/carol-example']) await brain.seed(slug, `---\ntitle: ${slug}\ntype: person\n---\n\n${slug} fixture.\n`);
      await brain.seed('notes/secret-example', '---\ntitle: Secret\ntype: person\nvisibility: private\n---\n\nPrivate fixture.\n');
      await brain.seed('people/outside-example', '---\ntitle: Outside\ntype: person\n---\n\nOutside the grant.\n');
      await brain.seed(SMALL, conversationPage(1_500_000, { seed: 1 }));
      await brain.seed(BIG, conversationPage(6_000_000, { seed: 2 }));
      await brain.seed(INLINE, conversationPage(20_000, { seed: 3 }));
      await brain.seed(TAKES_SEGMENTED, `${conversationPage(1_500_000, { seed: 4 }).trimEnd()}${OPEN_TAKES}`);
      await brain.seed(TAKES_INLINE, `${conversationPage(20_000, { seed: 5 }).trimEnd()}${OPEN_TAKES}`);
      await brain.seed(FENCED_LATER, `${conversationPage(20_000, { seed: 6 }).trimEnd()}\n\n${PLACEHOLDER}\n`);
      await brain.seed(BUSY, conversationPage(1_500_000, { seed: 9 }));
      await brain.seed(BUSY_INLINE, conversationPage(20_000, { seed: 10 }));
      // Stored as written (no import screen), so the append's publication is the write that normalizes the fence.
      await brain.engine.putPage(NORMALIZED, { type: 'note', title: 'Normalized', compiled_truth: `${conversationBody(20_000, { seed: 11 })}${TWO_DASH_TAKES}`, timeline: '', frontmatter: {} } as never,
        { sourceId: 'default' });
      for (const slug of [SMALL, BIG, TAKES_SEGMENTED, BUSY]) expect((await brain.body(slug)).storage).toBe('segmented');
      for (const slug of [INLINE, TAKES_INLINE, FENCED_LATER, BUSY_INLINE, NORMALIZED]) expect((await brain.body(slug)).storage).toBe('inline');
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('a remote append links the pages it mentions and reads only the appended bytes, at 1.5 MB and 6 MB', async () => {
      for (const slug of [SMALL, BIG]) {
        const text = mentions('notes/alice-example', 'notes/secret-example', 'notes/ghost-example', 'people/outside-example');
        const res = await deferred(() => append(slug, text));
        const [queued] = await linksEffects(slug);
        expect(queued!.state).toBe('queued');
        expect(queued!.data.range.end - queued!.data.range.start).toBe(res.appended_bytes);
        const work = await runLinks(slug);
        // Exactly the live segments the appended bytes overlap (the new tail: old tail text plus the append), at either page size.
        const { start, end } = queued!.data.range;
        const [page] = await brain.engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
        const overlapped = (await brain.engine.readManifest(Number(page!.id), { region: 'truth' })).filter(row => row.byteStart < end && row.byteStart + row.byteLen > start);
        expect(overlapped.length).toBeGreaterThan(0);
        expect(overlapped.length).toBeLessThanOrEqual(2);
        expect(work).toEqual({ segments: overlapped.length, bytes: overlapped.reduce((n, row) => n + row.byteLen, 0) });
        expect(work.bytes).toBeLessThanOrEqual(SEGMENT_MAX_BYTES + res.appended_bytes);
        expect(await edges(slug)).toEqual([mention('notes/alice-example')]);
        const [settled] = await linksEffects(slug);
        expect(settled!.outcome).toMatchObject({ links: 'committed', added: 1, removed: 0 });
        expect(new Map(settled!.outcome!.skipped_targets.map((t: { slug: string; reason: string }) => [t.slug, t.reason]))).toEqual(new Map([
          ['notes/secret-example', 'not_visible'], ['notes/ghost-example', 'missing'], ['people/outside-example', 'outside_grant']]));
      }
    }, 300_000);

    test('appends never remove an edge, and two appends whose effects run after both link both', async () => {
      await deferred(async () => {
        await append(SMALL, mentions('notes/bob-example'));
        await append(SMALL, mentions('notes/carol-example'));
      });
      await runLinks(SMALL);
      expect(await edges(SMALL)).toEqual([mention('notes/alice-example'), mention('notes/bob-example'), mention('notes/carol-example')]);
      expect((await linksEffects(SMALL)).slice(-2).map(e => e.outcome)).toEqual([
        { links: 'committed', added: 1, removed: 0, skipped_targets: [] }, { links: 'committed', added: 1, removed: 0, skipped_targets: [] }]);
    }, 300_000);

    test('an inline page: the visible mention links, a private one does not, and a rewrite of the appended text supersedes its effect', async () => {
      await deferred(() => append(INLINE, mentions('notes/alice-example', 'notes/secret-example')));
      await runLinks(INLINE);
      expect(await edges(INLINE)).toEqual([mention('notes/alice-example')]);
      expect((await linksEffects(INLINE)).at(-1)!.outcome).toMatchObject({ added: 1, skipped_targets: [{ slug: 'notes/secret-example', reason: 'not_visible' }] });
      const page = await brain.body(INLINE);
      await deferred(() => append(INLINE, mentions('notes/bob-example')));
      const rewritten = await brain.call('put_page', { slug: INLINE, content: `---\ntitle: Conversation log\ntype: note\n---\n\n${page.truth}\n\nRewritten tail.\n`, request_id: randomUUID(), force: true });
      expect(rewritten).toMatchObject({ isError: false });
      await runLinks(INLINE);
      expect((await linksEffects(INLINE)).at(-1)!.outcome).toEqual({ links: 'skipped', reason: 'superseded' });
      expect(await remoteEdges(INLINE)).toEqual([mention('notes/alice-example')]);
    }, 300_000);

    test('appended text inside a takes fence left open at the tail of a segmented page is not mined', async () => {
      await deferred(() => append(TAKES_SEGMENTED, mentions('notes/alice-example')));
      expect((await brain.body(TAKES_SEGMENTED)).truth.endsWith('[[notes/alice-example]].')).toBe(true);
      await runLinks(TAKES_SEGMENTED);
      expect(await edges(TAKES_SEGMENTED)).toEqual([]);
      expect((await linksEffects(TAKES_SEGMENTED)).at(-1)!.outcome).toEqual({ links: 'committed', added: 0, removed: 0, skipped_targets: [] });
    }, 300_000);

    test('an inline page: a remote append onto an open takes fence is refused; appended text a later edit fences is not mined', async () => {
      const refused = await brain.call('append_page', { slug: TAKES_INLINE, text: mentions('notes/alice-example'), request_id: randomUUID() }, { remote: true });
      expect(refused).toMatchObject({ isError: true, body: { code: 'invalid_params' } });
      expect(await linksEffects(TAKES_INLINE)).toEqual([]);
      // The trusted edit turns the line before the appended text into a takes begin marker and closes the fence after it; the
      // appended bytes keep their offsets and hash, so the effect runs at the later revision and reads them as the remote writer may: hidden.
      await deferred(() => append(FENCED_LATER, mentions('notes/alice-example')));
      const before = await brain.body(FENCED_LATER);
      const edited = await brain.call('put_page', { slug: FENCED_LATER, force: true, request_id: randomUUID(),
        content: `---\ntitle: Conversation log\ntype: note\n---\n\n${before.truth.replace(PLACEHOLDER, TAKES_BEGIN)}\n<!--- gbrain:takes:end -->\n` });
      expect(edited).toMatchObject({ isError: false });
      const after = await brain.body(FENCED_LATER);
      expect(after.truth.startsWith(before.truth.replace(PLACEHOLDER, TAKES_BEGIN))).toBe(true);
      await runLinks(FENCED_LATER);
      expect(await remoteEdges(FENCED_LATER)).toEqual([]);
      expect((await linksEffects(FENCED_LATER)).at(-1)!.outcome).toEqual({ links: 'committed', added: 0, removed: 0, skipped_targets: [] });
    }, 300_000);

    test('appends landing between the effect\'s read and its page lock do not make it retry, and its edge lands', async () => {
      for (const slug of [BUSY_INLINE, BUSY]) {
        await deferred(() => append(slug, mentions('notes/alice-example')));
        const [{ id }] = await brain.engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_effects WHERE kind='links' AND data->>'slug'=$1 ORDER BY id DESC LIMIT 1", [slug]);
        // Seam: just before the effect takes its page lock (its transaction), another remote append to the page lands. The
        // effect runs here, outside the consumer, so the consumer publishes that append; its own links effect waits (deferred),
        // since the effect worker would otherwise queue it behind the running one this append's caller is waiting on.
        const original = brain.engine.transaction;
        const claim = original.bind(brain.engine) as typeof original;
        let landed = 0;
        let running = false;
        // A transaction engine inherits this property, so its nested transactions (savepoints) come through here too.
        brain.engine.transaction = (async function (this: AppendBrain['engine'], fn: (tx: never) => Promise<unknown>, ...rest: unknown[]) {
          if (running && landed < BUSY_LANDINGS && String(fn).includes('lockedPage(')) {
            landed++;
            await deferred(() => append(slug, `${filler}\n\nAnother agent's turn ${landed}.`));
          }
          return (original as (...args: unknown[]) => Promise<unknown>).call(this, fn, ...rest);
        }) as typeof brain.engine.transaction;
        // Counted seam: each pass claims the effect and runs it once, as the effect worker does; a revision_conflict is the
        // contention the worker would retry 250 ms later.
        let attempts = 0;
        try {
          for (;;) {
            attempts++;
            const effect = await claim(async tx => {
              await declarePersistenceProtocol(tx);
              return (await tx.executeRaw<PersistenceEffect>(`UPDATE persistence_effects SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '10 minutes',
                attempts=attempts+1 WHERE id=$1 AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING *`, [id, randomUUID()]))[0]!;
            });
            running = true;
            try { await runLinksEffect(brain.engine, effect, randomUUID()); break; }
            catch (error) { if ((error as { code?: string }).code !== 'revision_conflict' || attempts >= BUSY_LANDINGS) throw error; }
            finally { running = false; }
          }
        } finally { brain.engine.transaction = original; }
        expect({ attempts, landed }).toEqual({ attempts: 1, landed: 1 });
        expect((await linksEffects(slug)).find(e => e.request_id && e.state === 'committed' && e.outcome?.added === 1)).toBeDefined();
        expect(await remoteEdges(slug)).toEqual([mention('notes/alice-example')]);
      }
    }, 300_000);

    test('an inline append whose publication normalizes a fence before it mines its own text', async () => {
      await deferred(() => append(NORMALIZED, mentions('notes/alice-example')));
      const stored = (await brain.body(NORMALIZED)).truth;
      expect(stored).toContain('<!--- gbrain:takes:begin -->');
      const [effect] = (await linksEffects(NORMALIZED)).slice(-1);
      expect(Buffer.byteLength(stored)).toBe(effect!.data.range.end);
      await runLinks(NORMALIZED);
      expect(await remoteEdges(NORMALIZED)).toEqual([mention('notes/alice-example')]);
      expect((await linksEffects(NORMALIZED)).at(-1)!.outcome).toEqual({ links: 'committed', added: 1, removed: 0, skipped_targets: [] });
    }, 300_000);
  });
}
