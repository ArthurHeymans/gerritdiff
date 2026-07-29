import { Suspense } from "react";
import { ClankerApp } from "@/components/clanker-app";

export default function Home() {
  return (
    <Suspense>
      <ClankerApp />
    </Suspense>
  );
}
