import { Card } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession } from '@/lib/auth/claims';
import { RoleForm } from './role-form';

// Member list. Adding people is installer-led in v1, so there is no invite
// control here — the list plus role changes (owner only) is the whole
// surface. Email addresses live in auth.users, which the client cannot
// read; each row shows the member id, with the signed-in member's email
// shown on their own row.
export default async function MembersPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  const isOwner = claims.memberRole === 'owner';

  const { data: members } = await supabase
    .from('org_members')
    .select('user_id, role, created_at')
    .order('created_at');

  return (
    <Card
      title="Members"
      sub={
        members && members.length > 0 ? (
          <span className="ow-machine">
            {members.length} {members.length === 1 ? 'person' : 'people'}
          </span>
        ) : undefined
      }
      padded={false}
      note={
        <>
          Everyone with access to this operation.
          {isOwner ? ' Role changes save per person.' : ' Role changes need the owner.'} Adding
          someone new is handled by your installer.
        </>
      }
    >
      {!members || members.length === 0 ? (
        <div className="ow-listitem">
          <p className="ow-body">No members found.</p>
        </div>
      ) : (
        <ul>
          {members.map((member) => {
            const isSelf = member.user_id === user?.id;
            return (
              <li key={member.user_id} className="ow-listitem">
                <div className="ow-inline" style={{ justifyContent: 'space-between' }}>
                  <span className="ow-body" style={{ minWidth: 0 }}>
                    {isSelf && user?.email ? (
                      <>
                        <b>{user.email}</b> <span className="ow-quiet">· you</span>
                      </>
                    ) : (
                      <span className="ow-machine">member {member.user_id.slice(0, 8)}</span>
                    )}
                  </span>
                  {isOwner ? (
                    <RoleForm userId={member.user_id} role={member.role} />
                  ) : (
                    <span className="ow-badge neutral">{member.role}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
