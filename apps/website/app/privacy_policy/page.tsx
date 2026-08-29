import { LegalPage, LegalSection } from '@/components/legal/LegalPage';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — DashSquad',
  description:
    'How DashSquad handles your data. The desktop app runs on your machine, your conversations and API keys stay local, and we run no analytics or trackers.',
};

const CONTACT = 'hello@dashsquad.ai';

export default function PrivacyPolicy() {
  return (
    <LegalPage
      eyebrow="LEGAL"
      title="Privacy Policy"
      lastUpdated="29 August 2026"
      intro="DashSquad is software you install and run on your own computer. This policy explains what stays on your machine, what leaves it, and the small number of things we ever see."
    >
      <LegalSection id="summary" title="1. The short version">
        <ul>
          <li>
            <strong>Your data stays on your machine.</strong> Agent configurations, conversations,
            session transcripts, files and API keys are stored locally under <code>~/.dash</code>.
            We have no access to them.
          </li>
          <li>
            <strong>No analytics, no trackers, no cookies.</strong> Neither this website nor the
            desktop app ships analytics, advertising, session recording or crash reporting.
          </li>
          <li>
            <strong>You choose who your agents talk to.</strong> Prompts go directly from your
            computer to the AI provider whose API key you configured. We are not in the middle.
          </li>
          <li>
            <strong>We never sell your data</strong> and we do not use your conversations to train
            models.
          </li>
          <li>
            Two optional features involve servers other than your own — remote access (section 6)
            and automatic updates (section 7). Both are described below.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="who-we-are" title="2. Who we are">
        <p>
          DashSquad (&ldquo;DashSquad&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) publishes the
          DashSquad desktop application and operates the website at dashsquad.ai. We are the data
          controller for the limited personal data described in this policy. You can reach us at{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </LegalSection>

      <LegalSection id="website" title="3. This website">
        <p>
          dashsquad.ai is a static site. It sets no cookies, includes no analytics or advertising
          scripts, and does not fingerprint or profile visitors. Web fonts are bundled at build time
          and served from our own domain, so loading a page does not call third-party font servers.
        </p>
        <p>
          Our hosting provider processes standard server request logs — IP address, user agent,
          requested URL, timestamp — to deliver the site and protect it against abuse. We do not use
          those logs to build profiles of visitors.
        </p>
        <p>
          The site links out to GitHub for downloads and source code. Once you follow such a link,
          the destination&apos;s own privacy policy applies.
        </p>
      </LegalSection>

      <LegalSection id="local-data" title="4. The desktop app: what stays on your computer">
        <p>
          You do not need an account to install or use DashSquad locally. Everything the app creates
          is written to your own disk, by default under <code>~/.dash</code>:
        </p>
        <ul>
          <li>Agent definitions, model choices, tool permissions and other configuration.</li>
          <li>
            Conversation history and session transcripts, stored as append-only files so you can
            audit exactly what an agent did.
          </li>
          <li>Per-agent workspaces and any files your agents read or write there.</li>
          <li>
            Provider API keys and other credentials, encrypted at rest with AES-256-GCM. The
            encryption key is held in your operating system keychain.
          </li>
          <li>Application and gateway logs.</li>
        </ul>
        <p>
          None of this is uploaded to us. We cannot read it, and we have no mechanism to request it.
        </p>
      </LegalSection>

      <LegalSection id="third-parties" title="5. Services you connect">
        <p>
          DashSquad is useful because it talks to services you choose. Those connections are made
          directly from your computer, using your own accounts and keys.
        </p>
        <h3>AI model providers</h3>
        <p>
          When an agent runs, your prompts, the relevant conversation context, tool results and any
          files you attach are sent to the provider you configured — for example Anthropic, OpenAI,
          Google or OpenRouter. That provider&apos;s terms and privacy policy govern what happens to
          the data, including whether it is retained or used for training. We recommend reviewing
          those policies before connecting a provider.
        </p>
        <h3>Messaging platforms</h3>
        <p>
          If you connect a channel such as WhatsApp, Telegram or Slack, messages between you and
          your agents pass through that platform and are subject to its privacy policy.
        </p>
        <h3>Connectors, tools and plugins</h3>
        <p>
          Agents can be granted tools — running commands, reading and writing files, browsing the
          web, or reaching systems through connectors. Those tools act with the permissions you
          grant them and connect directly to the systems you point them at. Grant access
          deliberately, and only to systems you are authorised to use.
        </p>
      </LegalSection>

      <LegalSection id="remote-access" title="6. Optional remote access">
        <p>
          DashSquad offers an optional feature that lets you reach your agents from another device
          when you are away from the computer they run on. It is off unless you turn it on.
        </p>
        <p>If you enable it:</p>
        <ul>
          <li>
            You sign in through our identity provider, which gives us your email address and an
            account identifier so we know which devices belong to you.
          </li>
          <li>
            Traffic is forwarded between your device and your own machine over an encrypted
            connection. The relay is a pipe: we do not store the contents of your conversations.
          </li>
          <li>
            We process connection metadata — timestamps, device and gateway identifiers, IP
            addresses and byte counts — to route connections, enforce limits and investigate abuse.
          </li>
        </ul>
        <p>
          If you never enable remote access, you never create an account with us and we hold no
          personal data about you at all.
        </p>
      </LegalSection>

      <LegalSection id="updates" title="7. Automatic updates">
        <p>
          Installed builds of the desktop app check for new releases on GitHub so you can stay up to
          date. That request tells GitHub your IP address and the app version you are running; it is
          handled under GitHub&apos;s privacy policy. We do not receive those requests, and no usage
          data is attached to them. You can block the check at your firewall if you prefer to update
          manually.
        </p>
      </LegalSection>

      <LegalSection id="never" title="8. What we never do">
        <ul>
          <li>We do not ship analytics, telemetry or crash reporting in the app.</li>
          <li>We do not sell, rent or share your personal information for advertising.</li>
          <li>We do not use your conversations, files or agent output to train models.</li>
          <li>We do not read the contents of relayed traffic.</li>
        </ul>
      </LegalSection>

      <LegalSection id="legal-bases" title="9. Legal bases for processing">
        <p>
          Where the EU or UK GDPR applies, we rely on: our legitimate interests in delivering and
          securing the website and the relay service; performance of a contract with you when you
          create an account for remote access; compliance with legal obligations; and your consent
          where consent is required. You may object to processing based on legitimate interests by
          contacting us.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="10. How long data is kept">
        <ul>
          <li>
            <strong>Local data</strong> is kept until you delete it. Removing the{' '}
            <code>~/.dash</code> directory and uninstalling the app removes your agents,
            conversations and stored credentials from your machine.
          </li>
          <li>
            <strong>Remote access account data</strong> is kept while your account is active and
            deleted within 30 days of you closing it.
          </li>
          <li>
            <strong>Server and relay logs</strong> are kept for a short period — normally no more
            than 30 days — for security and troubleshooting, then deleted.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="rights" title="11. Your rights">
        <p>
          Depending on where you live, you may have rights to access, correct, delete, export or
          restrict the processing of your personal data, and to complain to a supervisory authority.
          For data on your own machine you already have direct control — the files are yours to
          read, export or delete. For account or relay data held by us, email{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will respond within the period required
          by applicable law.
        </p>
        <p>
          We do not sell or share personal information as those terms are defined under California
          law, and we do not process sensitive personal information for inferring characteristics.
        </p>
      </LegalSection>

      <LegalSection id="transfers" title="12. International transfers">
        <p>
          Our service providers may process the limited data described above in countries other than
          your own. Where such transfers involve personal data protected by the EU or UK GDPR, we
          rely on appropriate safeguards such as standard contractual clauses.
        </p>
      </LegalSection>

      <LegalSection id="security" title="13. Security">
        <p>
          Credentials are encrypted at rest and protected by your operating system keychain, agents
          run with restricted permissions, and relayed connections are encrypted in transit.
          DashSquad is alpha software, however, and no system is perfectly secure — please keep your
          machine and your provider keys protected, and review what you grant your agents access to.
        </p>
        <p>
          If you believe you have found a security vulnerability, please report it privately to{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a> rather than opening a public issue.
        </p>
      </LegalSection>

      <LegalSection id="children" title="14. Children">
        <p>
          DashSquad is not directed to children and is not intended for use by anyone under 16. We
          do not knowingly collect personal data from children. If you believe a child has provided
          us with personal data, contact us and we will delete it.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="15. Changes to this policy">
        <p>
          We may update this policy as the product develops. The date at the top of the page always
          reflects the current version, and we will highlight material changes on the website or in
          release notes. Continuing to use DashSquad after a change means you accept the updated
          policy.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="16. Contact us">
        <p>
          Questions about this policy, or about privacy in DashSquad generally, go to{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
