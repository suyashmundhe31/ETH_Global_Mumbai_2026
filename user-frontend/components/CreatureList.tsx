"use client";
import { useEffect, useState } from "react";

type Creature = Record<string, string>;

export default function CreatureList() {
  const [creatures, setCreatures] = useState<Creature[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/creatures")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setCreatures(d.creatures)))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p>{error}</p>;
  if (!creatures) return <p>Loading…</p>;
  if (!creatures.length) return <p>No creatures yet.</p>;

  return (
    <>
      {creatures.map((c) => (
        <pre key={c.$key}>{Object.entries(c).map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
      ))}
    </>
  );
}