import { useEffect, useState } from "react";
import { motion } from "framer-motion";

import {
  Dumbbell,
  Activity,
  Sparkles,
  Zap,
  Baby,
  Swords,
  Trophy,
} from "lucide-react";

import { api } from "@/lib/api";

const icons = [
  Dumbbell,
  Activity,
  Sparkles,
  Zap,
  Baby,
  Swords,
  Trophy,
];

const fallback = [
  {
    name: "CrossFit",
    description:
      "High-intensity functional movements combining weightlifting, cardio, and gymnastics.",
  },
  {
    name: "Gymnastics",
    description:
      "Build strength, flexibility, and body control through dynamic movements.",
  },
  {
    name: "Body Toning",
    description:
      "Sculpt and define your muscles with targeted exercises.",
  },
  {
    name: "Fit Revolution",
    description:
      "A high-energy workout combining cardio, strength, and endurance.",
  },
  {
    name: "Karate Kids",
    description:
      "Martial arts training for children, building confidence and focus.",
  },
  {
    name: "MMA",
    description:
      "Mixed Martial Arts combining striking and grappling techniques.",
  },
  {
    name: "Boxing",
    description:
      "Footwork, combinations, and conditioning for all skill levels.",
  },
];

export default function Classes() {
  const [classes, setClasses] = useState<any[]>([]);
  const [status, setStatus] = useState<
    "loading" | "live" | "fallback"
  >("loading");

  useEffect(() => {
    api<any>("/api/classes")
      .then((result) => {
        setClasses(result.classes || []);
        setStatus("live");
      })
      .catch(() => {
        setClasses(fallback);
        setStatus("fallback");
      });
  }, []);

  const items = status === "fallback" ? fallback : classes;

  return (
    <section
      id="classes"
      className="py-24 bg-background"
    >
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-10"
        >
          <h2 className="font-display text-5xl md:text-7xl gradient-text mb-6">
            OUR CLASSES
          </h2>

          <p className="max-w-2xl mx-auto text-muted-foreground text-lg">
            Discover our diverse range of fitness and martial arts
            classes designed to challenge and transform you.
          </p>

          <p className="mt-3 text-xs">
            {status === "loading"
              ? "Loading classes..."
              : status === "live"
                ? "● Live classes from Vitality database"
                : "Showing sample classes – backend unavailable"}
          </p>
        </motion.div>

        {status === "live" && items.length === 0 ? (
          <div className="bg-card border rounded-xl p-8 text-center text-muted-foreground">
            No classes have been added yet. The administrator can
            create classes from the management tools.
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {items.map((item, i) => {
              const Icon = icons[i % icons.length];

              return (
                <motion.div
                  key={item.id || item.name}
                  initial={{ opacity: 0, scale: 0.95 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  className="group bg-card rounded-2xl p-6 border border-border"
                >
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                    <Icon className="w-6 h-6 text-primary" />
                  </div>

                  <h3 className="font-display text-xl mb-2">
                    {item.name}
                  </h3>

                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {item.description ||
                      item.category ||
                      "Train with Vitality."}
                  </p>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}