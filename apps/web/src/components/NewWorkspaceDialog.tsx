import { DEFAULT_MODEL_BY_PROVIDER, type ProjectId, type ProviderKind } from "@matcha/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { AVAILABLE_PROVIDER_OPTIONS } from "./chat/ProviderModelPicker";
import { ClaudeAI, OpenAI, type Icon } from "./Icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

const PROVIDER_ICON: Record<string, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
};

const PROVIDER_DESCRIPTION: Record<string, string> = {
  codex: "OpenAI Codex",
  claudeAgent: "Anthropic Claude",
};

export interface NewWorkspaceResult {
  projectId: ProjectId;
  provider: ProviderKind;
  model: string;
  branch: string | null;
  name: string;
}

interface NewWorkspaceDialogProps {
  open: boolean;
  projectId: ProjectId | null;
  projectName: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: NewWorkspaceResult) => Promise<void> | void;
}

export function NewWorkspaceDialog({
  open,
  projectId,
  projectName,
  onOpenChange,
  onConfirm,
}: NewWorkspaceDialogProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<ProviderKind>("codex");
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvider("codex");
    setBranch("");
    setName("");
    setError(null);
    setIsCreating(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const handleConfirm = useCallback(async () => {
    if (!projectId) return;
    setIsCreating(true);
    setError(null);
    try {
      await onConfirm({
        projectId,
        provider,
        model: DEFAULT_MODEL_BY_PROVIDER[provider],
        branch: branch.trim() || null,
        name: name.trim(),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace.");
    } finally {
      setIsCreating(false);
    }
  }, [projectId, provider, branch, name, onConfirm, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCreating) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          {projectName && (
            <DialogDescription>Create a new workspace in {projectName}.</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel className="space-y-5">
          {/* Provider selection */}
          <fieldset className="grid gap-1.5">
            <legend className="text-xs font-medium text-foreground">Provider</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
                const ProviderIcon = PROVIDER_ICON[option.value];
                const isSelected = provider === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                      isSelected
                        ? "border-primary bg-primary/6 ring-1 ring-primary/30"
                        : "border-border hover:border-foreground/20 hover:bg-muted/40",
                    )}
                    onClick={() => setProvider(option.value)}
                    disabled={isCreating}
                  >
                    {ProviderIcon && (
                      <ProviderIcon
                        aria-hidden="true"
                        className={cn(
                          "size-5 shrink-0",
                          option.value === "claudeAgent"
                            ? "text-[#d97757]"
                            : "text-muted-foreground/80",
                        )}
                      />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{option.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {PROVIDER_DESCRIPTION[option.value] ?? ""}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Workspace name (optional) */}
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Input
              ref={nameInputRef}
              value={name}
              placeholder="New workspace"
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isCreating) {
                  event.preventDefault();
                  void handleConfirm();
                }
              }}
              disabled={isCreating}
            />
          </label>

          {/* Branch name (optional) */}
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">
              Branch <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Input
              value={branch}
              placeholder="main"
              onChange={(event) => setBranch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isCreating) {
                  event.preventDefault();
                  void handleConfirm();
                }
              }}
              disabled={isCreating}
            />
          </label>

          {error && <p className="text-destructive text-xs">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={isCreating}
          >
            {isCreating ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
