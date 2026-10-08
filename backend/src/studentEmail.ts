// The rule for a new student's mailbox address (set by the owner):
//   first word + "." + last word of the name, lowercase, plain a-z and 0-9
//   one-word name -> just that word
//   already taken  -> a number is added after the name: x.y1, x.y2, ...
// Existing students follow it (e.g. "ZAID KHAN JAKIR KHAN PATHAN" -> zaid.pathan).

// Accents are folded to their plain letter; anything else that is not a-z or
// 0-9 is dropped. Null when the name has no usable letters at all.
export function emailBase(name: string): string | null {
    const words = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .split(/\s+/)
        .map((word) => word.replace(/[^a-z0-9]/g, ""))
        .filter((word) => word.length > 0);

    if (words.length === 0) {
        return null;
    }

    return words.length === 1 ? words[0]! : `${words[0]}.${words[words.length - 1]}`;
}

// base, base1, base2, ... up to `count` candidates.
export function* emailCandidates(base: string, count: number): Generator<string> {
    yield base;

    for (let n = 1; n < count; n++) {
        yield `${base}${n}`;
    }
}
