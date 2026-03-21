import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { SecureSandbox } from '@/components/SecureSandbox';
import { DeployAndRun } from '@/components/DeployAndRun';
import { AIProviders } from '@/components/AIProviders';
import { MessagingApps } from '@/components/MessagingApps';

export default function Home() {
  return (
    <main>
      <Nav />
      <Hero />
      <SecureSandbox />
      <DeployAndRun />
      <AIProviders />
      <MessagingApps />
    </main>
  );
}
