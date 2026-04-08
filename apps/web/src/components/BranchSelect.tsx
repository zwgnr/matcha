import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { gitBranchSearchInfiniteQueryOptions } from "../lib/gitReactQuery";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
} from "./ui/combobox";

interface BranchSelectProps {
  /** Project working directory for listing branches. */
  cwd: string | null;
  /** Currently selected branch name (empty string = none). */
  value: string;
  /** Called when the user picks a branch. */
  onChange: (branch: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Lightweight branch picker combobox for use in dialogs.
 *
 * Uses the same infinite-scroll git branch search as the main branch toolbar,
 * but without checkout, worktree, or env-mode logic.
 */
export function BranchSelect({ cwd, value, onChange, disabled, placeholder }: BranchSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();

  const {
    data: searchData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
  } = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      cwd,
      query: trimmedQuery,
      enabled: isOpen,
    }),
  );

  const branches = useMemo(
    () => searchData?.pages.flatMap((page) => page.branches) ?? [],
    [searchData?.pages],
  );
  const branchNames = useMemo(() => branches.map((b) => b.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((b) => [b.name, b] as const)),
    [branches],
  );

  const normalizedQuery = trimmedQuery.toLowerCase();
  const filteredItems = useMemo(
    () =>
      normalizedQuery.length === 0
        ? branchNames
        : branchNames.filter((name) => name.toLowerCase().includes(normalizedQuery)),
    [branchNames, normalizedQuery],
  );

  const totalCount = searchData?.pages[0]?.totalCount ?? 0;
  const statusText = isPending
    ? "Loading branches..."
    : isFetchingNextPage
      ? "Loading more branches..."
      : hasNextPage
        ? `Showing ${branches.length} of ${totalCount} branches`
        : null;

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) setQuery("");
  }, []);

  // Infinite scroll
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const maybeFetchNext = useCallback(() => {
    if (!isOpen || !hasNextPage || isFetchingNextPage) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 96) return;
    void fetchNextPage().catch(() => undefined);
  }, [fetchNextPage, hasNextPage, isOpen, isFetchingNextPage]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isOpen) return;
    const handler = () => maybeFetchNext();
    el.addEventListener("scroll", handler, { passive: true });
    handler();
    return () => el.removeEventListener("scroll", handler);
  }, [isOpen, maybeFetchNext]);

  useEffect(() => {
    maybeFetchNext();
  }, [branches.length, maybeFetchNext]);

  const setListRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = (el?.parentElement as HTMLDivElement | null) ?? null;
  }, []);

  return (
    <Combobox
      items={branchNames}
      filteredItems={filteredItems}
      autoHighlight
      open={isOpen}
      onOpenChange={handleOpenChange}
      value={value || null}
    >
      <ComboboxInput
        className="[&_input]:font-sans w-full"
        placeholder={placeholder ?? "Select a branch..."}
        size="default"
        value={isOpen ? query : value}
        onChange={(event) => setQuery(event.target.value)}
        disabled={disabled || (isPending && branches.length === 0 && !isOpen)}
      />
      <ComboboxPopup side="bottom" className="w-(--anchor-width)">
        <ComboboxEmpty>No branches found.</ComboboxEmpty>
        <ComboboxList ref={setListRef} className="max-h-48">
          {filteredItems.map((name, index) => {
            const branch = branchByName.get(name);
            const badge = branch?.current
              ? "current"
              : branch?.isRemote
                ? "remote"
                : branch?.isDefault
                  ? "default"
                  : null;
            return (
              <ComboboxItem
                hideIndicator
                key={name}
                index={index}
                value={name}
                onClick={() => {
                  onChange(name);
                  setIsOpen(false);
                  setQuery("");
                }}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="truncate">{name}</span>
                  {badge && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>
                  )}
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
        {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}
