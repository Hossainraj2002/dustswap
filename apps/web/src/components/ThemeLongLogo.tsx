import Image, { type ImageProps } from "next/image";

type ThemeLongLogoProps = Omit<ImageProps, "src" | "alt"> & {
  alt?: string;
  wrapperClassName?: string;
};

export function ThemeLongLogo({
  alt = "DustSwap",
  className,
  wrapperClassName = "",
  ...props
}: ThemeLongLogoProps) {
  const imageClassName = className ?? "";

  return (
    <span
      role="img"
      aria-label={alt}
      className={`inline-grid shrink-0 ${wrapperClassName}`}
    >
      <Image
        {...props}
        src="/longlogo.png"
        alt=""
        aria-hidden="true"
        className={`${imageClassName} col-start-1 row-start-1 dark:hidden`}
      />
      <Image
        {...props}
        src="/longlogowhite.png"
        alt=""
        aria-hidden="true"
        className={`${imageClassName} col-start-1 row-start-1 hidden dark:block`}
      />
    </span>
  );
}
