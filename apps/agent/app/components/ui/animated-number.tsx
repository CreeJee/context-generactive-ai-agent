import { motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useEffect } from "react";

const numbers = new Intl.NumberFormat("ko-KR");

/**
 * A count that eases to each new value instead of jumping, so a number refreshed while work goes on
 * reads as progress. The value is animated and formatted on the way out; screen readers get only
 * the value itself, and reduced motion shows it at once.
 */
function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const reduced = useReducedMotion();
  const spring = useSpring(value, { stiffness: 90, damping: 20 });
  const text = useTransform(spring, (latest) => numbers.format(Math.round(latest)));

  useEffect(() => {
    if (reduced) spring.jump(value);
    else spring.set(value);
  }, [reduced, spring, value]);

  return (
    <span data-slot="animated-number" className={className}>
      <motion.span aria-hidden className="tabular-nums">
        {text}
      </motion.span>
      <span className="sr-only">{numbers.format(value)}</span>
    </span>
  );
}

export { AnimatedNumber };
