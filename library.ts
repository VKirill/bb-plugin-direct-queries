import type { AdGroup, Campaign, DirectClient, Keyword, SharedSet } from "./direct.ts";
import { directSafe, rulePhrase, words } from "./negatives.ts";

export { directSafe };

export const LIBRARY_CHAR_LIMIT = 4096;
export const MAX_PARTS = 3;
export const MAX_SETS_PER_GROUP = 3;

export type LibraryDirect = Pick<
  DirectClient,
  "addSharedSet" | "updateSharedSet" | "updateAdGroupSharedSets" | "deleteKeywords"
>;

export interface ApprovedPhrase {
  phrase: string;
  campaignId?: number;
}

export interface LibraryPlanInput {
  campaigns: Campaign[];
  groups: AdGroup[];
  sharedSets: SharedSet[];
  keywords: Keyword[];
  approved: ApprovedPhrase[];
  managed?: Record<string, string[]>;
}

export interface LibraryCreate {
  name: string;
  phrases: string[];
}

export interface LibraryUpdate {
  id: number;
  name: string;
  phrases: string[];
}

export interface LibraryAttach {
  groupId: number;
  keepSetIds: number[];
}

export interface ConflictingKeyword {
  Id: number;
  Keyword: string;
  CampaignId: number;
  AdGroupId: number;
}

export interface LibraryCampaignPlan {
  campaignId: number;
  campaignName: string;
  libraryName: string;
  additions: string[];
  updates: LibraryUpdate[];
  creates: LibraryCreate[];
  attach: LibraryAttach[];
  existingSetIds: number[];
  deleteKeywords: ConflictingKeyword[];
}

export interface LibraryPlan {
  campaigns: LibraryCampaignPlan[];
}

export interface LibrarySyncResult {
  added: number;
  created: number;
  attached: number;
  deletedKeywords: ConflictingKeyword[];
  errors: { campaignId: number; error: string }[];
}

const OPERATOR = /[!\[\]"+]/;

function foldYo(text: string): string {
  return text.replaceAll("ё", "е").replaceAll("Ё", "е");
}

export function phraseKey(item: string): string {
  let text = foldYo(item).toLowerCase().trim().replace(/^"+|"+$/g, "");
  text = text.replace(/(?<!\S)!/g, "");
  text = text.replace(/(?<=[\p{L}\p{N}_])-(?=[\p{L}\p{N}_])/gu, " ");
  return text.split(/\s+/).filter(Boolean).sort().join(" ");
}

export function stems(item: string): string {
  return phraseKey(item)
    .split(" ")
    .filter(Boolean)
    .map((word) => word.slice(0, 5))
    .sort()
    .join(" ");
}

export function samePhrases(left: string[], right: string[]): boolean {
  const a = new Set(left.map(stems));
  const b = new Set(right.map(stems));
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function commonPrefixLen(left: string, right: string): number {
  const n = Math.min(left.length, right.length);
  let i = 0;
  while (i < n && left[i] === right[i]) i += 1;
  return i;
}

function sameWord(left: string, right: string): boolean {
  const a = foldYo(left);
  const b = foldYo(right);
  const common = commonPrefixLen(a, b);
  return common >= 3 && common >= Math.min(a.length, b.length) - 2 && Math.abs(a.length - b.length) <= 3;
}

export function keywordConflicts(keyword: string, negatives: string[]): string[] {
  const own = words(keyword.split(" -")[0]).map(foldYo);
  return negatives.filter((item) =>
    words(item)
      .map(foldYo)
      .every((word) => own.some((other) => sameWord(word, other))),
  );
}

export function phrase(query: string, generic: Iterable<string> = []): string {
  return rulePhrase(query, generic instanceof Set ? generic : new Set(generic));
}

export function phraseLength(items: string[]): number {
  return items.reduce((sum, item) => sum + item.replace(/[\s\-+!\[\]"()]/g, "").length, 0);
}

export function splitParts(
  parts: { NegativeKeywords: string[] }[],
  combined: string[],
): { chunks: string[][]; overflow: string[] } {
  const wanted = new Set(combined);
  const placed = new Set<string>();
  const chunks: string[][] = [];
  for (const part of parts) {
    const chunk: string[] = [];
    for (const raw of part.NegativeKeywords) {
      const item = raw.replace(/^"+|"+$/g, "");
      if (wanted.has(item) && !placed.has(item)) {
        chunk.push(item);
        placed.add(item);
      }
    }
    chunks.push(chunk);
  }
  for (const item of combined) {
    if (placed.has(item)) continue;
    let target = chunks.find((chunk) => phraseLength([...chunk, item]) <= LIBRARY_CHAR_LIMIT);
    if (!target) {
      target = [];
      chunks.push(target);
    }
    target.push(item);
    placed.add(item);
  }
  const overflow = chunks.slice(MAX_PARTS).flat();
  return { chunks: chunks.slice(0, MAX_PARTS).filter((chunk) => chunk.length > 0), overflow };
}

export function dropRedundant(items: string[]): string[] {
  const plain = items.map((item) => (OPERATOR.test(item) ? null : new Set(phraseKey(item).split(" ").filter(Boolean))));
  return items.filter((_, i) => {
    const own = plain[i];
    if (own === null) return true;
    return !plain.some((other) => other !== null && other.size < own.size && [...other].every((w) => own.has(w)));
  });
}

export type NegativesIndex = [Set<string>, Set<string>[]];

export function negativesIndex(pool: string[]): NegativesIndex {
  return [
    new Set(pool.map(phraseKey)),
    pool.filter((item) => !OPERATOR.test(item)).map((item) => new Set(phraseKey(item).split(" ").filter(Boolean))),
  ];
}

export function covered(item: string, index: NegativesIndex): boolean {
  const [keys, plain] = index;
  if (keys.has(phraseKey(item))) return true;
  if (OPERATOR.test(item)) return false;
  const own = new Set(phraseKey(item).split(" ").filter(Boolean));
  return plain.some((other) => other.size > 0 && [...other].every((w) => own.has(w)));
}

export function libraryName(campaignName: string): string {
  return `ПЗГО - ${campaignName.replaceAll("—", "-")}`;
}

function partNames(base: string): string[] {
  return [base, ...Array.from({ length: MAX_PARTS - 1 }, (_, i) => `${base} ${i + 2}`)];
}

function partsFor(sets: SharedSet[], base: string): SharedSet[] {
  const byName = new Map(sets.map((item) => [item.Name, item]));
  return partNames(base).flatMap((name) => {
    const found = byName.get(name);
    return found ? [found] : [];
  });
}

function uniquePhrases(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = directSafe(raw);
    if (!item) continue;
    const key = phraseKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function planLibrarySync(input: LibraryPlanInput): LibraryPlan {
  const campaigns: LibraryCampaignPlan[] = [];
  for (const campaign of input.campaigns) {
    const base = libraryName(campaign.Name);
    const parts = partsFor(input.sharedSets, base);
    const current = parts.flatMap((part) => part.NegativeKeywords);
    const index = negativesIndex(current);
    const approved = uniquePhrases(
      input.approved
        .filter((row) => row.campaignId === undefined || row.campaignId === campaign.Id)
        .map((row) => row.phrase),
    );
    const additions: string[] = [];
    const existingKeys = new Set(current.map(phraseKey));
    for (const item of approved) {
      if (existingKeys.has(phraseKey(item)) || covered(item, index)) continue;
      additions.push(item);
      existingKeys.add(phraseKey(item));
    }
    const combined = dropRedundant([...current.map((item) => item.replace(/^"+|"+$/g, "")), ...additions]);
    const { chunks } = splitParts(
      parts.map((part) => ({ NegativeKeywords: part.NegativeKeywords })),
      combined,
    );
    const updates: LibraryUpdate[] = [];
    const creates: LibraryCreate[] = [];
    const names = partNames(base);
    chunks.forEach((chunk, i) => {
      const name = names[i] ?? `${base} ${i + 1}`;
      const existing = parts[i];
      if (!existing) {
        creates.push({ name, phrases: chunk });
        return;
      }
      if (!samePhrases(existing.NegativeKeywords, chunk) || existing.NegativeKeywords.join("\0") !== chunk.join("\0")) {
        updates.push({ id: existing.Id, name: existing.Name, phrases: chunk });
      }
    });
    const existingSetIds = parts.map((part) => part.Id);
    const own = new Set(existingSetIds);
    const campaignGroups = input.groups.filter((group) => group.CampaignId === campaign.Id);
    const attach: LibraryAttach[] = campaignGroups
      .filter((group) => {
        const currentIds = group.NegativeKeywordSharedSetIds ?? [];
        if (additions.length === 0 && creates.length === 0 && existingSetIds.every((id) => currentIds.includes(id))) {
          return false;
        }
        return true;
      })
      .map((group) => ({
        groupId: group.Id,
        keepSetIds: (group.NegativeKeywordSharedSetIds ?? []).filter((id) => !own.has(id)),
      }));
    const negatives = uniquePhrases([...approved, ...additions]);
    const deleteKeywords = input.keywords
      .filter((keyword) => keyword.CampaignId === campaign.Id)
      .flatMap((keyword) => {
        const hits = keywordConflicts(keyword.Keyword, negatives);
        return hits.length
          ? [{ Id: keyword.Id, Keyword: keyword.Keyword, CampaignId: keyword.CampaignId, AdGroupId: keyword.AdGroupId }]
          : [];
      });
    if (!additions.length && !creates.length && !updates.length && !attach.length && !deleteKeywords.length) continue;
    campaigns.push({
      campaignId: campaign.Id,
      campaignName: campaign.Name,
      libraryName: base,
      additions,
      updates,
      creates,
      attach,
      existingSetIds,
      deleteKeywords,
    });
  }
  return { campaigns };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mergeSetIds(keepSetIds: number[], libraryIds: number[]): number[] {
  const libraries = libraryIds.slice(0, MAX_SETS_PER_GROUP);
  const room = Math.max(0, MAX_SETS_PER_GROUP - libraries.length);
  const keep = keepSetIds.filter((id) => !libraries.includes(id)).slice(0, room);
  return [...keep, ...libraries];
}

export async function applyLibrarySync(
  direct: LibraryDirect,
  plan: LibraryPlan,
  opts: { apply: boolean },
): Promise<LibrarySyncResult> {
  const result: LibrarySyncResult = { added: 0, created: 0, attached: 0, deletedKeywords: [], errors: [] };
  if (!opts.apply) return result;
  for (const campaign of plan.campaigns) {
    try {
      const createdIds: number[] = [];
      for (const item of campaign.creates) {
        createdIds.push(await direct.addSharedSet(item.name, item.phrases));
        result.created += 1;
      }
      for (const item of campaign.updates) {
        await direct.updateSharedSet(item.id, item.phrases);
      }
      result.added += campaign.additions.length;
      const libraryIds = [...campaign.existingSetIds, ...createdIds];
      if (campaign.attach.length) {
        await direct.updateAdGroupSharedSets(
          campaign.attach.map((group) => ({
            id: group.groupId,
            sharedSetIds: mergeSetIds(group.keepSetIds, libraryIds),
          })),
        );
        result.attached += campaign.attach.length;
      }
      if (campaign.deleteKeywords.length) {
        await direct.deleteKeywords(campaign.deleteKeywords.map((row) => row.Id));
        result.deletedKeywords.push(...campaign.deleteKeywords);
      }
    } catch (err) {
      result.errors.push({ campaignId: campaign.campaignId, error: errorMessage(err) });
    }
  }
  return result;
}
