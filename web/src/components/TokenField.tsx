import { useId, useRef, useState } from "react";
import { CloseIcon } from "./Icons";

// The same separators the script uses, so what the chips show and what the
// tag writer splits never disagree.
const ARTIST_SPLIT = /[,;，；、]/;

// Genre is a single tag on the other end, so the chips are written as one
// semicolon-separated value - the convention tag readers split on - and a comma
// stays part of a name like "Folk, World, & Country".
const GENRE_SPLIT = /[;；]/;

// Two spellings of one name fold together when only case, accents,
// punctuation, full-width forms or spacing differ, so "ARTIST1", "artist-1"
// and "Artist1" all reduce to the same name.
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    // Letters and digits of any script: a Cyrillic or Japanese folder name must
    // stay searchable instead of folding away to nothing.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Identity is the folded name with its word breaks removed as well, so
// "Artist1", "artist-1" and "Artist 1" are the same entry rather than three.
function foldKey(value: string): string {
  return fold(value).replace(/ /g, "");
}

function splitList(value: string, separator: RegExp): string[] {
  const names: string[] = [];
  for (const part of String(value || "").split(separator)) {
    const name = part.trim();
    if (name && !names.some((seen) => foldKey(seen) === foldKey(name))) names.push(name);
  }
  return names;
}

function splitArtists(value: string): string[] {
  return splitList(value, ARTIST_SPLIT);
}

function splitGenres(value: string): string[] {
  return splitList(value, GENRE_SPLIT);
}

// Levenshtein, only ever called with short names. Every option is scored on
// each keystroke, which stays cheap for the few hundred the API returns.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// Higher is a closer match; -1 means no match. An exact spelling wins, then a
// prefix of the whole name, then a prefix of any word, then a substring, and
// finally a name one or two edits away ("beatls" -> "Beatles").
function score(candidate: string, needle: string): number {
  const name = fold(candidate);
  if (!needle) return 0;
  if (name === needle) return 100;
  if (name.replace(/ /g, "") === needle.replace(/ /g, "")) return 95;
  if (name.startsWith(needle)) return 80;
  if (name.split(" ").some((word) => word.startsWith(needle))) return 70;
  if (name.includes(needle)) return 60;
  const allowance = needle.length <= 4 ? 1 : needle.length <= 8 ? 2 : 3;
  const closest = Math.min(
    editDistance(name, needle),
    ...name.split(" ").map((word) => editDistance(word, needle)),
  );
  return closest <= allowance ? 50 - closest : -1;
}

// The known spellings, best match first, never one already in the field.
// Everything is folded before it is compared.
function rank(options: string[], typed: string, taken: string[]): string[] {
  const needle = fold(typed);
  const already = new Set(taken.map(foldKey));
  return options
    .filter((name) => !already.has(foldKey(name)))
    .map((name) => ({ name, score: score(name, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((entry) => entry.name);
}

// What Enter commits when no suggestion is highlighted: the existing spelling
// of an exact match, otherwise what was typed. So "artist1" becomes "Artist1",
// while a genuinely new name is still accepted as it stands.
function canonical(options: string[], typed: string): string {
  const key = foldKey(typed);
  return options.find((name) => foldKey(name) === key) ?? typed.trim();
}

// One component for both list fields: names come from what already exists
// (the library's artists, the shipped genre vocabulary), so a value is reused
// instead of creating a near-duplicate ("The Beatles" vs "Beatles",
// "hardtekk" vs "Hardtekk"). A name becomes a chip on Enter or by picking a
// suggestion, the × beside it removes it, and the value stays the plain string
// the rest of the app already sends.
type TokenFieldProps = {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  split: (value: string) => string[];
  // What several chips become in the one value the tag writer receives.
  join: string;
  label: string;
  placeholder: string;
  emptyPlaceholder: string;
  createText: (name: string) => string;
  disabled?: boolean;
};

function TokenField({
  value,
  options,
  onChange,
  split,
  join,
  label,
  placeholder,
  emptyPlaceholder,
  createText,
  disabled,
}: TokenFieldProps) {
  // Both fields can be on the page at once (review card and tag editor), so the
  // ids the combobox points at are theirs alone.
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typing, setTyping] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const names = split(value);
  const key = foldKey(typing);
  // A name that already exists keeps its stored spelling; only a name the
  // vocabulary has never seen is offered as a new one.
  const known = Boolean(key) && options.some((name) => foldKey(name) === key);
  const repeated = Boolean(key) && names.some((name) => foldKey(name) === key);
  const canCreate = Boolean(key) && !known && !repeated;
  const rows: { name: string; create: boolean }[] = rank(options, typing, names)
    .slice(0, canCreate ? 7 : 8)
    .map((name) => ({ name, create: false }));
  if (canCreate) rows.push({ name: typing.trim(), create: true });
  const showing = open && rows.length > 0;

  // What was typed can itself be a list (a pasted "A, B"), and a name already
  // in the field is never added twice - "artist1" and "Artist1" count as one.
  function add(raw: string) {
    const next = [...names];
    for (const part of split(raw)) {
      const name = canonical(options, part);
      if (!next.some((taken) => foldKey(taken) === foldKey(name))) next.push(name);
    }
    setTyping("");
    setOpen(false);
    setActive(-1);
    if (next.length !== names.length) onChange(next.join(join));
  }

  function remove(name: string) {
    onChange(names.filter((taken) => taken !== name).join(join));
  }

  return (
    <div className="relative">
      <div
        className="field flex flex-wrap items-center gap-1.5"
        style={{ paddingTop: 8, paddingBottom: 6 }}
        onClick={() => inputRef.current?.focus()}
      >
        {names.map((name) => (
          <span key={name} className="tag relative" style={{ fontSize: 12, padding: "3px 14px 3px 9px" }}>
            {name}
            {!disabled && (
              <button
                type="button"
                className="absolute flex h-[14px] w-[14px] items-center justify-center rounded-full leading-none"
                style={{
                  top: -5,
                  right: -5,
                  background: "var(--surface)",
                  border: "1px solid var(--line-strong)",
                  color: "var(--ink-2)",
                }}
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  remove(name);
                }}
              >
                <CloseIcon size={9} />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          className="min-w-[80px] flex-1 bg-transparent text-[13.5px] outline-none"
          style={{ color: "var(--ink)" }}
          value={typing}
          disabled={disabled}
          onChange={(e) => {
            setTyping(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
            // Leaving the field keeps what was typed rather than discarding it.
            if (typing.trim()) add(canonical(options, typing));
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && rows.length) {
              event.preventDefault();
              setOpen(true);
              setActive((current) => (current + 1) % rows.length);
            } else if (event.key === "ArrowUp" && rows.length) {
              event.preventDefault();
              setOpen(true);
              setActive((current) => (current <= 0 ? rows.length - 1 : current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (showing && active >= 0 && rows[active]) add(rows[active].name);
              else if (typing.trim()) add(canonical(options, typing));
            } else if (event.key === "Backspace" && !typing && names.length) {
              // An empty box makes Backspace take the last chip back.
              remove(names[names.length - 1]);
            } else if (event.key === "Escape") {
              setOpen(false);
              setActive(-1);
            }
          }}
          placeholder={names.length ? placeholder : emptyPlaceholder}
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label}
          aria-activedescendant={active >= 0 ? `${listId}-option-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {showing && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-hidden rounded-[9px] py-1"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            boxShadow: "0 8px 24px rgb(0 0 0 / 16%)",
          }}
        >
          {rows.map((row, index) => (
            <li
              key={row.create ? `create:${row.name}` : row.name}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === active}
              className="cursor-pointer truncate px-3 py-1.5 text-[12.5px]"
              style={{ background: index === active ? "var(--surface-3)" : "transparent" }}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                // Keep the input focused so its blur does not close the list first.
                event.preventDefault();
                add(row.name);
              }}
            >
              {row.create ? (
                <span style={{ color: "var(--ink-2)" }}>{createText(row.name)}</span>
              ) : (
                row.name
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ArtistField(props: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <TokenField
      {...props}
      split={splitArtists}
      join=", "
      label="Artists"
      placeholder="Add another…"
      emptyPlaceholder="Artist, then Enter"
      createText={(name) => `Use “${name}” as a new artist`}
    />
  );
}

export function GenreField(props: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  emptyPlaceholder?: string;
  disabled?: boolean;
}) {
  const { emptyPlaceholder = "Genre, then Enter", ...rest } = props;
  return (
    <TokenField
      {...rest}
      split={splitGenres}
      join="; "
      label="Genres"
      placeholder="Add another…"
      emptyPlaceholder={emptyPlaceholder}
      createText={(name) => `Add “${name}” as a new genre`}
    />
  );
}
