import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";
import { Link } from "react-router-dom";

import {
  getMember,
  getToken,
  clearSession,
} from "@/lib/api";

import logo from "@/assets/logo.jpeg";

const navLinks = [
  { name: "About", href: "#about" },
  { name: "Classes", href: "#classes" },
  { name: "Schedule", href: "#schedule" },
  { name: "Hours", href: "#hours" },
  { name: "Stories", href: "#testimonials" },
];

const Navbar = () => {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [authenticated, setAuthenticated] = useState(
    Boolean(getToken())
  );

  const member = getMember();

  useEffect(() => {
    const sync = () => setAuthenticated(Boolean(getToken()));

    window.addEventListener("vitality-auth-changed", sync);

    return () =>
      window.removeEventListener("vitality-auth-changed", sync);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    window.addEventListener("scroll", handleScroll);

    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToSection = (href: string) => {
    setIsMobileMenuOpen(false);

    const element = document.querySelector(href);

    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  const logout = () => {
    clearSession();
    setAuthenticated(false);
    window.location.reload();
  };

  return (
    <>
      <motion.nav
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.6 }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          isScrolled
            ? "bg-background/95 backdrop-blur-md border-b border-border"
            : "bg-white"
        }`}
      >
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <a href="#" className="flex items-center">
              <img
                src={logo}
                alt="Vitality"
                className="h-12 w-auto"
              />
            </a>

            <div className="hidden md:flex items-center gap-8">
              {navLinks.map((link) => (
                <button
                  key={link.name}
                  onClick={() => scrollToSection(link.href)}
                  className="text-muted-foreground hover:text-primary transition-colors font-medium"
                >
                  {link.name}
                </button>
              ))}
            </div>

            <div className="hidden md:flex items-center gap-3">
              {authenticated ? (
                <>
                  <Link
                    to="/account"
                    className="text-sm font-semibold text-foreground hover:text-primary"
                  >
                    My Account
                  </Link>

                  <button
                    onClick={logout}
                    className="text-sm text-muted-foreground"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/login"
                    className="text-sm font-semibold text-foreground hover:text-primary"
                  >
                    Login
                  </Link>

                  <Link
                    to="/register"
                    className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold"
                  >
                    Join Now
                  </Link>
                </>
              )}
            </div>

            <button
              onClick={() =>
                setIsMobileMenuOpen(!isMobileMenuOpen)
              }
              className="md:hidden text-foreground p-2"
              aria-label="Toggle menu"
            >
              {isMobileMenuOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>
      </motion.nav>

      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-background pt-20 md:hidden"
          >
            <div className="container mx-auto px-6 py-8">
              <div className="flex flex-col gap-6">
                {authenticated ? (
                  <Link
                    to="/account"
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="font-display text-3xl"
                  >
                    My Account
                  </Link>
                ) : (
                  <>
                    <Link
                      to="/login"
                      onClick={() => setIsMobileMenuOpen(false)}
                      className="font-display text-3xl"
                    >
                      Login
                    </Link>

                    <Link
                      to="/register"
                      onClick={() => setIsMobileMenuOpen(false)}
                      className="font-display text-3xl"
                    >
                      Join Now
                    </Link>
                  </>
                )}

                {navLinks.map((link) => (
                  <button
                    key={link.name}
                    onClick={() => scrollToSection(link.href)}
                    className="font-display text-3xl text-foreground hover:text-primary transition-colors text-left"
                  >
                    {link.name}
                  </button>
                ))}

                {authenticated && (
                  <button
                    onClick={logout}
                    className="font-display text-2xl text-left text-muted-foreground"
                  >
                    Logout
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navbar;