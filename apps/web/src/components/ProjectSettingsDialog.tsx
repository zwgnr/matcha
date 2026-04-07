import type { ProjectId, ProjectScript } from "@matcha/contracts";
import { setupProjectScript } from "@matcha/shared/projectScripts";
import { UploadIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

interface ProjectSettingsDialogProps {
  open: boolean;
  projectId: ProjectId | null;
  projectName: string | null;
  scripts: ProjectScript[];
  onOpenChange: (open: boolean) => void;
  onSave: (projectId: ProjectId, scripts: ProjectScript[]) => Promise<void> | void;
}

export function ProjectSettingsDialog({
  open,
  projectId,
  projectName,
  scripts,
  onOpenChange,
  onSave,
}: ProjectSettingsDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [setupCommand, setSetupCommand] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const existingSetup = setupProjectScript(scripts);
    setSetupCommand(existingSetup?.command ?? "");
    setError(null);
    setIsSaving(false);
  }, [open, scripts]);

  const handleSave = useCallback(async () => {
    if (!projectId) return;
    setIsSaving(true);
    setError(null);
    try {
      const trimmedCommand = setupCommand.trim();
      const existingSetup = setupProjectScript(scripts);
      const otherScripts = scripts.filter((s) => !s.runOnWorktreeCreate);

      let nextScripts: ProjectScript[];
      if (trimmedCommand) {
        const setupScript: ProjectScript = {
          id: existingSetup?.id ?? "setup",
          name: existingSetup?.name ?? "Setup",
          command: trimmedCommand,
          icon: existingSetup?.icon ?? "configure",
          runOnWorktreeCreate: true,
        };
        nextScripts = [...otherScripts, setupScript];
      } else {
        nextScripts = otherScripts;
      }

      await onSave(projectId, nextScripts);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setIsSaving(false);
    }
  }, [projectId, setupCommand, scripts, onSave, onOpenChange]);

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", (e) => {
      const content = (e.target as FileReader | null)?.result;
      if (typeof content === "string") {
        setSetupCommand(content.trim());
      }
    });
    reader.readAsText(file);
    event.target.value = "";
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSaving) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
          {projectName && (
            <DialogDescription>Configure settings for {projectName}.</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="space-y-2">
            <div>
              <Label htmlFor="setup-command">Setup</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Runs when a new workspace with a worktree is created. Available environment
                variables: <code className="text-[11px]">MATCHA_PROJECT_ROOT</code>,{" "}
                <code className="text-[11px]">MATCHA_WORKTREE_PATH</code>.
              </p>
            </div>
            <Textarea
              id="setup-command"
              size="sm"
              placeholder={`cp "$MATCHA_PROJECT_ROOT/.env.local" .env.local\nbun install`}
              value={setupCommand}
              onChange={(event) => {
                setSetupCommand(event.target.value);
                setError(null);
              }}
              disabled={isSaving}
              className="font-mono text-xs"
            />
            <div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSaving}
              >
                <UploadIcon className="size-3" />
                Import file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".sh,.bash,.zsh,.txt,*"
                onChange={handleFileSelected}
              />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
