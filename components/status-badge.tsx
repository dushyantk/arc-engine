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

export function ShotStatusBadge({
  status,
}: {
  status: keyof typeof SHOT_STATUS_CONFIG;
}) {
  const { variant, label, Icon } = SHOT_STATUS_CONFIG[status];
  return (
    <Badge variant={variant}>
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
