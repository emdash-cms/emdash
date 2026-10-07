# EmDash governance

EmDash is led by a Project Lead and operated by a Project Team and Maintainers. This document defines those roles, how decisions are made, and how people join or leave the teams.

The role lists in this file are canonical. GitHub, Discord, publishing, infrastructure, and administrative access support a role but do not define it. Someone can hold Write or Admin access for technical or administrative reasons without being a Maintainer. Bots can hold repository permissions and review pull requests, but a bot is never a Maintainer or Project Team member.

## Current team

### Project Lead

- [Matt Kane (@ascorbic)](https://github.com/ascorbic)

### Maintainers

<!-- maintainers:start -->

- [Matt Kane (@ascorbic)](https://github.com/ascorbic)
- [Noah Nguyen Pham (@khoinguyenpham04)](https://github.com/khoinguyenpham04)
- [@MA2153](https://github.com/MA2153)
- [Kevin Kyburz (@swissky)](https://github.com/swissky)
- [Daniel Mueller (@danielmlr)](https://github.com/danielmlr)

<!-- maintainers:end -->

### Other Project Team members

- [@masonjames](https://github.com/masonjames)
- [@BenjaminPrice](https://github.com/BenjaminPrice)
- [@CacheMeOwside](https://github.com/CacheMeOwside)

Maintainers are also members of the Project Team. Former members can be recognised separately without retaining project access.

## Work in public by default

Product direction, architecture, roadmap priorities, feature acceptance, proposals, bug evidence, review judgments, and project policy belong in public GitHub Discussions, issues, design pull requests, and implementation pull requests.

Discord can help people discover and coordinate work, but it must not hold the only record of a decision. Record the conclusion of a private, synchronous, or Discord conversation in the relevant public GitHub artifact.

## Public and private channels

A channel is any place where project discussion happens: GitHub Discussions, issues, and pull requests as well as Discord channels and calls. Use public channels for discovery and informal community input. Use the relevant GitHub Discussion, issue, design pull request, or implementation pull request for substantive reasoning and the durable decision record.

Use the public `#contributing` Discord channel for contributing, triage, roadmap, proposals, implementation, and project operations. Threads keep individual subjects together.

Use `#project-team` for trusted operational coordination, including:

- finding an owner or reviewer;
- handing work over during leave or limited availability;
- coordinating duplicate cleanup or a triage rotation;
- preparing an agenda or public response;
- asking for help with a difficult public thread; and
- flagging public work that needs attention.

`#project-team` is not a second forum for product, architecture, roadmap, proposal, review, or governance decisions. Discussion about what the project should do is public. Coordination about who will handle the work can happen in `#project-team`. Use the public channel when the boundary is unclear.

Use `#maintainers` only for subjects that cannot be discussed safely in public:

- private security disclosures and embargoed fixes;
- Code of Conduct and moderation cases involving identifiable people;
- appointments, removals, and private concerns about an individual's suitability;
- credentials, secrets, and production administration; and
- legal, privacy, or confidential partner information.

Calls can be used for coordination. Publish an agenda beforehand when practical, and record decisions on GitHub. Attendance at calls is not required to participate in governance.

## Project roles

### Project Team

The Project Team consists of trusted, regular contributors who help operate the project in public. Contributions can include code, documentation, issue and Discussion triage, reviews, design, support, and community work.

Project Team members can:

- triage and classify issues, Discussions, and pull requests;
- close duplicates and work that is clearly outside documented project policy;
- help contributors develop proposals and choose the appropriate process;
- coordinate reviews, handoffs, and community work;
- participate fully in planning, proposal, and governance discussions; and
- review pull requests and provide technical or product feedback.

Project Team membership does not grant merge authority. A Project Team review is useful evidence, but it does not satisfy a required Maintainer approval.

Project Team members receive GitHub Triage access and the Project Team role in Discord by default.

### Maintainers

Maintainers are Project Team members trusted to approve and merge changes and apply project policy consistently.

Maintainers can:

- perform all Project Team responsibilities;
- provide the human Maintainer approval required for a pull request to merge;
- merge changes that meet the documented design, review, and test requirements;
- accept or decline work where an existing policy or accepted design supplies the direction; and
- share responsibility for compatibility, security, release quality, and contributor experience.

Maintainers receive GitHub Write access by default. Write access does not include package publishing, releases, production systems, secrets, or repository administration unless the person needs that capability for an agreed responsibility.

### Project Lead

The Project Lead is the Maintainer accountable for the project's overall direction and governance. The Project Lead:

- makes the final decision when consultation does not produce a clear outcome;
- appoints Project Team members and Maintainers after consulting the active Maintainers;
- decides product, architecture, roadmap, and governance questions that have not been delegated through an accepted policy or design;
- holds repository Admin access and grants other privileged capabilities according to need; and
- can take immediate action to protect the project during a security, conduct, or operational incident.

The Project Lead seeks public input on public project decisions and consults the Maintainers before exercising this authority. Ordinary work within an accepted design or documented policy does not require separate Project Lead approval.

Cloudflare appoints the Project Lead.

When the Project Lead is away, they designate a Maintainer to act for them and set the scope of that delegation. RFC acceptance normally waits for the Project Lead's return. Other decisions within the delegated scope, including design pull requests, can be made by the designated Maintainer.

## Decision-making

Discussion and consensus are preferred. Maintainers make routine decisions within documented policy without waiting for the Project Lead. Escalate a decision when it establishes new direction, conflicts with an accepted design, changes governance, or cannot reach agreement through normal review.

The Project Lead makes the final call after consultation and explains public decisions in the relevant public artifact.

Area ownership and rotations help route work; they do not create a veto or additional authority. Rotations allow handoff and skipped turns and do not create a standing time commitment.

## Joining the Project Team

Someone can join the Project Team when they have:

- made multiple useful contributions to the project or its community over time;
- demonstrated constructive judgment and dependable collaboration;
- participated in at least one public project working space; and
- expressed an interest in ongoing project responsibilities.

Useful contributions include code, documentation, reviews, triage, design, support, and community work. Regular Discord activity is not required, and GitHub-focused contributors are not excluded.

Anyone can express interest or suggest a candidate. A Maintainer normally sponsors the candidate. Active Maintainers have an opportunity to raise relevant concerns privately, and the Project Lead makes the appointment. Announce successful appointments publicly. Do not publish unsuccessful nominations or private concerns.

## Becoming a Maintainer

A Maintainer candidate normally belongs to the Project Team and has demonstrated:

- sustained ownership and sound technical or project judgment;
- useful work beyond their own proposed changes, such as reviews, triage, planning, documentation, or contributor support;
- consistent application of compatibility, scope, security, and contribution policies;
- constructive representation of the project in public; and
- current capacity and interest to share Maintainer responsibilities.

An existing Maintainer nominates an interested candidate. Active Maintainers discuss the nomination privately, and the Project Lead makes the final decision. Announce the appointment publicly after the candidate accepts it.

There is no fixed maximum size for the Project Team or Maintainers. Each group contains the qualified, active people who have genuine responsibilities to perform. Maintainer membership remains more selective because every appointment adds merge authority and supply-chain exposure.

## Participation and access review

Project Team members and Maintainers are volunteers. There is no minimum number of hours, commits, reviews, or other contributions. Members can take breaks and can step down at any time without giving a reason.

Members remain sufficiently involved to exercise their responsibilities with current project context. Activity includes implementation, review, triage, planning, documentation, support, and community work.

The project handles inactivity through a private check-in:

- After roughly six months without meaningful project activity, the Project Lead or another Maintainer contacts the member privately.
- A member who expects to return after a break can remain in the role when appropriate.
- A Maintainer who no longer expects to participate can move to the Project Team or an alumni role.
- An inactive Project Team member can move to an alumni role.
- If the person does not respond within a reasonable period, remove unnecessary access.
- Returning alumni use a lightweight reappointment process that confirms current interest and account security while recognising previous service.

Review privileged access at least annually. Review GitHub, package publishing, releases, infrastructure, secrets, and Discord administration separately.

Dormant privileged accounts create supply-chain risk. An abandoned or compromised account can otherwise retain the ability to approve or merge code, modify automation, or publish releases without prompt detection. Removing unused access is a security and responsibility decision, not criticism of previous contributions.

## Related processes

- [Maintaining EmDash](MAINTAINING.md) defines review and merge requirements.
- [Contributing to EmDash](CONTRIBUTING.md) directs contributors to the appropriate process.
- [Project Team triage](TRIAGE.md) defines day-to-day triage work.
- [Feature plans and RFCs](proposals/README.md) define the design process.
- [Roadmap](ROADMAP.md) defines how project-led work is planned.
- [AI usage policy](AI_POLICY.md) defines permitted AI assistance and communication.
