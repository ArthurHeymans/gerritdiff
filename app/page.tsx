import { Suspense } from "react";
import { GerritDiffApp } from "@/components/gerritdiff-app";

export default function Home() {
  return (
    <Suspense>
      <GerritDiffApp />
    </Suspense>
  );
}
