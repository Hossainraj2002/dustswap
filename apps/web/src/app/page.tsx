import { redirect } from "next/navigation";

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function buildProfileRedirectUrl(
  searchParams?: Record<string, string | string[] | undefined>
) {
  const nextSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry) {
          nextSearchParams.append(key, entry);
        }
      }
      continue;
    }

    if (value) {
      nextSearchParams.set(key, value);
    }
  }

  const query = nextSearchParams.toString();
  return query ? `/profile?${query}` : "/profile";
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  redirect(buildProfileRedirectUrl(resolvedSearchParams));
}
