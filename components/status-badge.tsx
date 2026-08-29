import { AlertTriangle, Check, CircleDashed, UserCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const SHOT_STATUS_CONFIG = {
  pending: { variant: "outline", label: "Pending", Icon: CircleDashed },
  generating: { variant: "outline", label: "Generating", Icon: CircleDashed },
  reviewing: { variant: "outline", label: "Reviewing", Icon: CircleDashed },
  revise: { variant: "warning", label: "Revise", Icon: AlertTriangle },
  approved: { variant: "success", label: "Approved", Icon: Check },
  needs_human: { variant: "info", label: "Needs human", Icon: UserCheck },
} as const;

const VERSION_STATUS_CONFIG = {
  candidate: { variant: "outline", label: "Candidate", Icon: CircleDashed },
  failed: { variant: "destructive", label: "Failed", Icon: XCircle },
  approved: { variant: "success", label: "Approved", Icon: Check },
} as const;

const SEQUENCE_STATUS_CONFIG = {
  pending: { variant: "outline", label: "Pending", Icon: CircleDashed },
  needs_human: { variant: "info", label: "Needs human", Icon: UserCheck },
  approved: { variant: "success", label: "Continuity approved", Icon: Check },
} as const;

export function ShotStatusBadge({
  status,
  testId,
}: {
  status: keyof typeof SHOT_STATUS_CONFIG;
  /** Opt-in hook for the shot detail header, where the shot's own status badge
   *  reads identically to the version badges further down the page. Passing it
   *  changes no markup anywhere it isn't passed. */
  testId?: string;
}) {
  const { variant, label, Icon } = SHOT_STATUS_CONFIG[status];
  return (
    <Badge variant={variant} data-testid={testId}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}

export function VersionStatusBadge({
  status,
}: {
  status: keyof typeof VERSION_STATUS_CONFIG;
}) {
  const { variant, label, Icon } = VERSION_STATUS_CONFIG[status];
  return (
    <Badge variant={variant}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}

export function SequenceStatusBadge({
  status,
}: {
  status: keyof typeof SEQUENCE_STATUS_CONFIG;
}) {
  const { variant, label, Icon } = SEQUENCE_STATUS_CONFIG[status];
  return (
    <Badge variant={variant}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}
