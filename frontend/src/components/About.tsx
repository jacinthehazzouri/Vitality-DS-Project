import { motion } from "framer-motion";
import { Users, Trophy, Heart } from "lucide-react";

const features = [
  {
    icon: Users,
    title: "Community Driven",
    description:
      "Join a supportive community of fitness enthusiasts who motivate and inspire each other daily.",
  },
  {
    icon: Trophy,
    title: "Expert Coaches",
    description:
      "Train with certified professionals who bring years of experience in fitness and martial arts.",
  },
  {
    icon: Heart,
    title: "All Levels Welcome",
    description:
      "Whether you're a beginner or an athlete, our programs adapt to your fitness journey.",
  },
];

const About = () => {
  return (
    <section id="about" className="py-24 bg-secondary">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="font-display text-5xl md:text-7xl gradient-text mb-6">
            ABOUT VITALITY
          </h2>
          <p className="max-w-3xl mx-auto text-muted-foreground text-lg leading-relaxed">
            At Vitality, we believe fitness is more than just exercise - it's a
            lifestyle. Our state-of-the-art facility combines cutting-edge
            equipment with expert coaching to help you achieve your goals. From
            high-intensity CrossFit sessions to disciplined martial arts
            training, we offer the perfect environment for your transformation.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: index * 0.15 }}
              className="card-gradient p-8 rounded-2xl border border-border"
            >
              <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mb-6">
                <feature.icon className="w-7 h-7 text-primary" />
              </div>
              <h3 className="font-display text-2xl text-foreground mb-3">
                {feature.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default About;
