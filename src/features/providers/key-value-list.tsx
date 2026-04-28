import type { KeyValuePair } from "../providers/types";

interface KeyValueListProps {
  readonly pairs: readonly KeyValuePair[];
  readonly onChange: (pairs: readonly KeyValuePair[]) => void;
  readonly keyPlaceholder?: string;
  readonly valuePlaceholder?: string;
  readonly addLabel?: string;
}

/** Lightweight key/value editor — used for extra request headers and the
 * extra_params body merge. Adds an empty draft row on demand. */
export function KeyValueList({
  pairs,
  onChange,
  keyPlaceholder = "key",
  valuePlaceholder = "value",
  addLabel = "Add row",
}: KeyValueListProps) {
  const updateAt = (idx: number, patch: Partial<KeyValuePair>) => {
    onChange(pairs.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };
  const removeAt = (idx: number) => {
    onChange(pairs.filter((_, i) => i !== idx));
  };
  const add = () => onChange([...pairs, { key: "", value: "" }]);

  return (
    <div className="kv-list">
      {pairs.length === 0 ? (
        <p className="kv-empty">No entries yet.</p>
      ) : (
        <div className="kv-rows">
          {pairs.map((pair, idx) => (
            <div className="kv-row" key={idx}>
              <input
                className="kv-input"
                value={pair.key}
                placeholder={keyPlaceholder}
                onChange={(e) => updateAt(idx, { key: e.target.value })}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <input
                className="kv-input"
                value={pair.value}
                placeholder={valuePlaceholder}
                onChange={(e) => updateAt(idx, { value: e.target.value })}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button
                type="button"
                className="kv-remove"
                onClick={() => removeAt(idx)}
                aria-label="Remove row"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="kv-add" onClick={add}>
        + {addLabel}
      </button>
    </div>
  );
}
