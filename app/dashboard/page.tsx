import { Suspense } from "react";
import { GerritDiffApp } from "@/components/gerritdiff-app";

export default function DashboardPage() {
  return (
    <Suspense>
      <GerritDiffApp />
    </Suspense>
  );
}
