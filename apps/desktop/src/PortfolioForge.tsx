import "./portfolio-forge.css";

/** Decorative. The enclosing bead supplies its title and work state. */
export function PortfolioForge() {
  return (
    <span aria-hidden="true" class="af-portfolio-forge">
      <span class="af-portfolio-forge-anvil" />
      <span class="af-portfolio-forge-iron" />
      <span class="af-portfolio-forge-hammer" />
      <span class="af-portfolio-forge-sparks" />
    </span>
  );
}
