// Student search: the typed text is split into words and every word must
// appear somewhere in the student's searchable text (name, email, college,
// admission ID), in any order and as a partial match, ignoring case. So
// "MOHD KHAN", "khan farman" and "farma moh kha" all find MOHD FARMAN KHAN.

// ILIKE treats % and _ as wildcards even in user-typed text (e.g. an
// admission ID like "A_102") - escape them (and the escape character itself)
// so each word is matched literally.
function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Real searches have a handful of words; the cap keeps a crafted very long
// search from running thousands of conditions (8,000 words took 12 s).
export const MAX_SEARCH_WORDS = 10;

// One ILIKE pattern per whitespace-separated word, at most MAX_SEARCH_WORDS.
// Never empty: blank text becomes "%%", which matches every student, so a
// caller that skips its own blank check still gets a valid query.
export function searchPatterns(search: string): string[] {
    const words = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
    return (words.length ? words : [""]).map((word) => `%${escapeLikePattern(word)}%`);
}

// "<column> ILIKE $n AND <column> ILIKE $n+1 ..." for `count` words whose
// patterns are bound from parameter number `firstParam` onwards.
export function searchClause(column: string, firstParam: number, count: number): string {
    return Array.from({ length: count }, (_, i) => `${column} ILIKE $${firstParam + i}`).join(" AND ");
}
