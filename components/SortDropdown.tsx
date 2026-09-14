"use client";

// A small, quiet <select> - shared by BotRunsPanel (one instance, sort) and
// RecentOrdersPanel (two instances, sort and status filter), the three
// places this app needs the exact same "label + dropdown" shape in a panel
// header. Kept generic over T (the option value type) rather than
// hardcoding either panel's own sort-key union, so both can reuse this one
// component without a shared "AnySortKey" type neither of them actually
// wants.
export type SortDropdownOption<T extends string> = {
  value: T;
  label: string;
};

export function SortDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly SortDropdownOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="text-muted flex items-center gap-1.5 text-xs">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="border-default bg-elevated text-fg focus:border-strong focus:ring-accent rounded-md border px-1.5 py-1 text-xs focus:ring-1 focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
