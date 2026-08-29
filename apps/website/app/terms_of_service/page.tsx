import { LegalPage, LegalSection } from '@/components/legal/LegalPage';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — DashSquad',
  description:
    'The terms that govern your use of the DashSquad desktop application, the optional remote access service, and the dashsquad.ai website.',
};

const CONTACT = 'hello@dashsquad.ai';

export default function TermsOfService() {
  return (
    <LegalPage
      eyebrow="LEGAL"
      title="Terms of Service"
      lastUpdated="29 August 2026"
      intro="These terms govern your use of the DashSquad desktop application, the optional remote access service and this website. Please read them — they include important limits on liability and on what autonomous agents may be used for."
    >
      <LegalSection id="acceptance" title="1. Agreement to these terms">
        <p>
          By downloading, installing or using DashSquad, or by using this website, you agree to
          these terms. If you are using DashSquad on behalf of an organisation, you confirm that you
          have authority to bind that organisation, and &ldquo;you&rdquo; means that organisation.
          If you do not agree, do not use DashSquad.
        </p>
      </LegalSection>

      <LegalSection id="what-it-is" title="2. What DashSquad is">
        <p>
          DashSquad is desktop software that lets you create and run AI agents on your own computer.
          The agents use AI model providers that you connect with your own API keys, and can be
          given tools and access to messaging platforms and other systems that you configure. We
          also operate an optional relay service that lets you reach your own machine remotely.
        </p>
        <p>
          DashSquad is not an AI model provider. We do not supply the models your agents use, and we
          are not a party to your relationship with the providers you connect.
        </p>
      </LegalSection>

      <LegalSection id="alpha" title="3. Alpha software">
        <p>
          DashSquad is early access, pre-release software. It may contain defects, behave
          unpredictably, lose data, or change in ways that are not backwards compatible. Features
          may be modified or withdrawn without notice, and there is no uptime commitment or service
          level agreement for any part of it, including the relay service.
        </p>
        <p>
          Do not rely on DashSquad as the sole store of anything important. Keep your own backups,
          and test agents on non-critical work before trusting them with more.
        </p>
      </LegalSection>

      <LegalSection id="licence" title="4. Licence to use the software">
        <p>
          Subject to these terms, we grant you a personal, non-exclusive, non-transferable,
          revocable licence to install and use the DashSquad application for your own personal or
          internal business purposes. Where a specific release is distributed under its own software
          licence, that licence governs the software itself and these terms govern the services we
          operate.
        </p>
        <p>You may not:</p>
        <ul>
          <li>remove or obscure any proprietary notices, branding or attribution;</li>
          <li>
            resell, sublicense or offer DashSquad to third parties as a hosted or managed service;
          </li>
          <li>
            reverse-engineer, decompile or disassemble the software, except to the extent that
            applicable law expressly permits it despite this restriction; or
          </li>
          <li>use DashSquad to build a substantially similar competing product.</li>
        </ul>
        <p>We reserve all rights not expressly granted.</p>
      </LegalSection>

      <LegalSection id="accounts" title="5. Accounts for remote access">
        <p>
          Using DashSquad locally requires no account. If you enable optional remote access, you
          create an account with us. You must be at least 18 years old, or the age of majority where
          you live, to create one. Provide accurate information, keep your credentials secure, and
          tell us promptly at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> if you suspect
          unauthorised use. You are responsible for activity that takes place under your account.
        </p>
      </LegalSection>

      <LegalSection id="responsibilities" title="6. Your keys, your costs, your agents">
        <p>
          <strong>Keys and costs.</strong> You bring your own API keys. All charges from AI
          providers, messaging platforms and any other service you connect are yours, billed by them
          directly. Agents can run autonomously and repeatedly, which means they can consume tokens
          and incur cost without you watching. Set spending limits with your providers and monitor
          your usage.
        </p>
        <p>
          <strong>Supervision.</strong> Agents take real actions: they can send messages, run
          commands, create and modify files, and reach systems you connect them to. You decide which
          tools and permissions each agent has, and you are responsible for everything your agents
          do under your configuration. Review agent output before relying on it, and do not point
          agents at systems or accounts you are not authorised to access.
        </p>
        <p>
          <strong>Compliance.</strong> You are responsible for using DashSquad lawfully, including
          any data protection, confidentiality, export control and sector-specific obligations that
          apply to the information you give your agents.
        </p>
      </LegalSection>

      <LegalSection id="your-content" title="7. Your content">
        <p>
          Your prompts, files, conversations and agent output remain yours. We claim no ownership of
          them and, because they are stored on your own machine, we have no access to them. If you
          use the relay service, you grant us only the limited right to transmit that traffic for
          the purpose of operating the service.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="8. Acceptable use">
        <p>You agree not to use DashSquad, or allow an agent you run to be used, to:</p>
        <ul>
          <li>break the law, or infringe anyone&apos;s intellectual property or privacy rights;</li>
          <li>
            access, probe or interfere with systems, accounts or data without proper authorisation;
          </li>
          <li>
            create or distribute malware, spam, phishing content, or material that is harassing,
            abusive, or sexually exploitative of minors;
          </li>
          <li>
            generate or spread content intended to deceive people about its origin, including
            impersonation and coordinated inauthentic activity;
          </li>
          <li>
            violate the terms of any service you connect, including AI providers and messaging
            platforms;
          </li>
          <li>
            circumvent security, rate limits or access restrictions in DashSquad or in the relay
            service; or
          </li>
          <li>
            make decisions with significant legal or safety consequences — including medical, legal
            or financial advice, employment, credit or housing decisions, or safety-critical control
            — without meaningful human review.
          </li>
        </ul>
        <p>
          We may suspend or terminate access to the services we operate if we reasonably believe
          this section has been breached.
        </p>
      </LegalSection>

      <LegalSection id="third-parties" title="9. Third-party services">
        <p>
          DashSquad connects to services operated by others. Your use of those services is governed
          by their own terms, and they may change, restrict or discontinue their offerings at any
          time. We are not responsible for third-party services, their availability, their pricing,
          or the accuracy of what they return.
        </p>
      </LegalSection>

      <LegalSection id="fees" title="10. Fees">
        <p>
          The DashSquad application is currently provided free of charge, as is the optional relay
          service. We may introduce paid plans in future; if we do, we will give notice before any
          feature you already use starts to carry a charge. Costs charged by AI providers and other
          connected services are always yours.
        </p>
      </LegalSection>

      <LegalSection id="feedback" title="11. Feedback">
        <p>
          If you send us bug reports, suggestions or other feedback, you grant us a perpetual,
          irrevocable, worldwide, royalty-free licence to use it to improve DashSquad, without
          obligation or attribution to you.
        </p>
      </LegalSection>

      <LegalSection id="privacy" title="12. Privacy">
        <p>
          Our handling of data is described in the <a href="/privacy_policy/">Privacy Policy</a>,
          which forms part of these terms.
        </p>
      </LegalSection>

      <LegalSection id="termination" title="13. Suspension and termination">
        <p>
          You may stop using DashSquad at any time by uninstalling it and, if you created one,
          closing your account. We may suspend or terminate access to the services we operate if you
          breach these terms, if your use creates risk or legal exposure, or if we discontinue a
          service. Terminating your account does not affect the software already installed on your
          machine or the data stored on it. Sections that by their nature should survive termination
          — including sections 7, 11, 14, 15, 16, 18 and 19 — continue to apply.
        </p>
      </LegalSection>

      <LegalSection id="disclaimers" title="14. Disclaimers">
        <p>
          DashSquad is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without
          warranties of any kind, whether express, implied or statutory, including implied
          warranties of merchantability, fitness for a particular purpose, non-infringement, and
          uninterrupted or error-free operation, to the fullest extent permitted by law.
        </p>
        <p>
          AI output can be inaccurate, incomplete or misleading, and agents can act on such output.
          Verify anything that matters before relying on it.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="15. Limitation of liability">
        <p>
          To the fullest extent permitted by law, we are not liable for indirect, incidental,
          special, consequential or punitive damages, or for lost profits, lost revenue, lost data,
          business interruption, or costs charged to you by AI providers or other third-party
          services, arising out of or relating to DashSquad, however caused and on any theory of
          liability.
        </p>
        <p>
          Our total aggregate liability arising out of or relating to DashSquad will not exceed the
          greater of the amounts you paid us in the twelve months before the event giving rise to
          the claim, or SGD 100.
        </p>
        <p>
          Nothing in these terms excludes or limits liability that cannot lawfully be excluded or
          limited, including liability for death or personal injury caused by negligence or for
          fraud.
        </p>
      </LegalSection>

      <LegalSection id="indemnity" title="16. Indemnity">
        <p>
          You agree to indemnify and hold us harmless from claims, damages, liabilities and
          reasonable legal costs arising from your use of DashSquad, the actions taken by agents you
          configure and run, your content, or your breach of these terms or of applicable law.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="17. Changes to these terms">
        <p>
          We may update these terms as DashSquad develops. The date at the top of the page reflects
          the current version, and we will flag material changes on the website or in release notes.
          Continuing to use DashSquad after a change takes effect means you accept the updated
          terms.
        </p>
      </LegalSection>

      <LegalSection id="law" title="18. Governing law and disputes">
        <p>
          These terms are governed by the laws of Singapore, without regard to its conflict of laws
          rules. The courts of Singapore have exclusive jurisdiction over any dispute arising out of
          or relating to these terms or to DashSquad. If you are a consumer, this does not deprive
          you of the protection of mandatory consumer rights in your country of residence.
        </p>
      </LegalSection>

      <LegalSection id="general" title="19. General">
        <p>
          These terms, together with the Privacy Policy, are the entire agreement between you and us
          regarding DashSquad. If any provision is found unenforceable, the rest remains in effect.
          Our failure to enforce a provision is not a waiver of it. You may not assign these terms
          without our consent; we may assign them in connection with a merger, acquisition or sale
          of assets. There are no third-party beneficiaries.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="20. Contact us">
        <p>
          Questions about these terms go to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
