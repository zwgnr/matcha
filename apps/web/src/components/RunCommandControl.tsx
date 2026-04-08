import type { ProjectId, WorkspaceId } from "@matcha/contracts";
import { ExternalLinkIcon, PlayIcon, SquareIcon } from "lucide-react";
import { type FormEvent, memo, useCallback, useState } from "react";

import { selectRunCommand, selectRunCommandRuntime, useRunCommandStore } from "~/runCommandStore";
import { Badge } from "./ui/badge";
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
import { Label } from "./ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface RunCommandControlProps {
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  onStart: () => void;
  onStop: () => void;
  onOpenPort: (port: number) => void;
}

export const RunCommandControl = memo(function RunCommandControl({
  projectId,
  workspaceId,
  onStart,
  onStop,
  onOpenPort,
}: RunCommandControlProps) {
  const command = useRunCommandStore((s) => selectRunCommand(s.commandByProjectId, projectId));
  const runtime = useRunCommandStore((s) =>
    selectRunCommandRuntime(s.runtimeByWorkspaceId, workspaceId),
  );
  const setCommand = useRunCommandStore((s) => s.setCommand);

  const [configOpen, setConfigOpen] = useState(false);
  const [draftCommand, setDraftCommand] = useState("");

  const handleClick = useCallback(() => {
    if (runtime.running) {
      onStop();
    } else if (command) {
      onStart();
    } else {
      // No command configured — open the config dialog
      setDraftCommand("");
      setConfigOpen(true);
    }
  }, [runtime.running, command, onStart, onStop]);

  const handleSaveCommand = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = draftCommand.trim();
      if (!trimmed) return;
      setCommand(projectId, trimmed);
      setConfigOpen(false);
    },
    [draftCommand, projectId, setCommand],
  );

  const tooltipLabel = runtime.running
    ? `Stop: ${command}`
    : command
      ? `Run: ${command}`
      : "Configure run command";

  return (
    <>
      <div className="flex items-center gap-1.5">
        {runtime.running &&
          runtime.detectedPorts.map((port) => (
            <Tooltip key={port}>
              <TooltipTrigger
                render={
                  <Badge
                    render={<button type="button" />}
                    variant="outline"
                    size="sm"
                    className="cursor-pointer gap-1 font-mono tabular-nums"
                    onClick={() => onOpenPort(port)}
                  >
                    :{port}
                    <ExternalLinkIcon className="size-2.5! opacity-60" />
                  </Badge>
                }
              />
              <TooltipPopup side="bottom">Open localhost:{port}</TooltipPopup>
            </Tooltip>
          ))}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={runtime.running ? "destructive-outline" : "outline"}
                onClick={handleClick}
                aria-label={runtime.running ? "Stop" : command ? "Run" : "Set run command"}
              >
                {runtime.running ? (
                  <SquareIcon className="size-3 fill-current" />
                ) : (
                  <PlayIcon className="size-3.5 fill-current" />
                )}
                <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                  {runtime.running ? "Stop" : command ? "Run" : "Set run"}
                </span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
        </Tooltip>
      </div>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Run Command</DialogTitle>
            <DialogDescription>
              Set a long-running dev command (e.g. <code>bun dev</code>). Launched from the play
              button in the header. This is set for the entire project across all workspaces.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id="run-command-config-form" onSubmit={handleSaveCommand}>
              <div className="space-y-1.5">
                <Label htmlFor="run-command-input">Command</Label>
                <Input
                  id="run-command-input"
                  autoFocus
                  placeholder="bun dev"
                  value={draftCommand}
                  onChange={(event) => setDraftCommand(event.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfigOpen(false)}>
              Cancel
            </Button>
            <Button form="run-command-config-form" type="submit" disabled={!draftCommand.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
