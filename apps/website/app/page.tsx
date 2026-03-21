import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { SecureSandbox } from '@/components/SecureSandbox';

export default function Home() {
  return (
    <main>
      <Nav />
      <Hero />
      <SecureSandbox />
    </main>
  );
}
