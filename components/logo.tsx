export function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className="flex justify-center items-center">
      <img
        src="/icon-transparent.png"
        alt="Axiom Lumen Logo"
        className={small ? "h-6 w-06 object-contain" : "h-12 w-auto object-contain"}
      />
      <img
        src="/header-logo.png"
        alt="Axiom Lumen Logo"
        className={small ? "h-6 w-auto object-contain ml-[-30px] -mt-1" : "h-10 w-auto object-contain ml-[-30px] -mt-1"}
      />
    </div>
  )
}
