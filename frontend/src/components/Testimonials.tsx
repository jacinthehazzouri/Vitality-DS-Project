import { motion } from "framer-motion";

const testimonials = [
  {
    name: "Charbel B.",
    quote:
      "A well-equipped gym with modern machines, clean facilities, and a motivating atmosphere. Great for all fitness levels",
  },
  {
    name: "Fatima A.",
    quote: "Very peaceful and energetic place. I love being there🫰🏻 …",
  },
  {
    name: "Afif A.",
    quote: "Great coaching staff that give you the training you really need",
  },
  {
    name: "Souha B.",
    quote: "My preferred gymmmmm",
  },
];

const Testimonials = () => {
  return (
    <section id="testimonials" className="py-24 bg-secondary">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="font-display text-5xl md:text-7xl gradient-text mb-6">
            MEMBER STORIES
          </h2>
          <p className="max-w-2xl mx-auto text-muted-foreground text-lg">
            Real experiences from our Vitality family. Their success is our
            motivation.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-8">
          {testimonials.map((testimonial, index) => (
            <motion.div
              key={testimonial.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
              className="relative card-gradient rounded-2xl p-8 border border-border"
            >
              <p className="text-foreground/90 text-lg leading-relaxed mb-6 italic">
                {testimonial.quote}
              </p>
              <div>
                <p className="font-display text-xl text-primary">
                  {testimonial.name}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
