<?php
// FICTIONAL test patient for the opt-in real-OpenEMR checks (tests/e2e/browser/openemr-frame.mjs). Never run it against a real hospital's OpenEMR.
// Creates, inside OpenEMR 7.0.3 with OpenEMR's own patient service: Salma Alfaris-Test, a penicillin allergy entered as free text (OpenEMR sends such an allergy
// with the code "unknown" and the name only in the narrative), two active problems, one medicine, and the code descriptions the image lacks.
//   docker cp tests/e2e/browser/openemr-test-patient.php oe:/tmp/ && docker exec -u apache oe php /tmp/openemr-test-patient.php
// (run as the web server's user, not root). A visit is opened in the chart afterwards, by the frame script or by hand.
$_GET['site'] = 'default';
$_SERVER['HTTP_HOST'] = 'localhost';
$ignoreAuth = true;
require_once('/var/www/localhost/htdocs/openemr/interface/globals.php');
use OpenEMR\Services\PatientService;
use OpenEMR\Common\Uuid\UuidRegistry;

$service = new PatientService();
$result = $service->insert([
    'fname' => 'Salma', 'lname' => 'Alfaris-Test', 'DOB' => '1968-03-14', 'sex' => 'Female', 'pubpid' => 'TEST-ORD-1',
    'street' => '1 Test Street', 'city' => 'Testville', 'state' => 'XX', 'postal_code' => '00000', 'country_code' => 'SA',
]);
$data = $result->getData();
$pid = $data[0]['pid'] ?? null;
echo "pid=" . json_encode($pid) . " validation=" . json_encode($result->getValidationMessages()) . "\n";
if (!$pid) { exit(1); }

// Code descriptions (the image has no code tables): ICD-10 for the two problems and RxNorm for the medicine.
$types = [];
foreach (sqlStatement("select ct_key, ct_id from code_types") as $row) { $types[$row['ct_key']] = $row['ct_id']; }
function addCode($types, $key, $code, $text) {
    if (!isset($types[$key])) { return; }
    $exists = sqlQuery("select id from codes where code = ? and code_type = ?", [$code, $types[$key]]);
    if (!$exists) { sqlInsert("insert into codes (code_text, code_text_short, code, code_type, active) values (?, ?, ?, ?, 1)", [$text, $text, $code, $types[$key]]); }
}
addCode($types, 'ICD10', 'I10', 'Essential (primary) hypertension');
addCode($types, 'ICD10', 'E11.9', 'Type 2 diabetes mellitus without complications');
addCode($types, 'RXCUI', '860975', 'Metformin hydrochloride 500 MG Oral Tablet');
addCode($types, 'RXNORM', '860975', 'Metformin hydrochloride 500 MG Oral Tablet');

// The chart: a penicillin allergy, two active problems, one medicine.
sqlInsert("insert into lists (date, type, title, begdate, activity, pid, user, groupname, diagnosis, reaction, severity_al, verification) values (now(), 'allergy', 'Penicillin', '2019-05-01', 1, ?, 'admin', 'Default', '', 'Urticaria', 'severe', 'confirmed')", [$pid]);
sqlInsert("insert into lists (date, type, title, begdate, activity, pid, user, groupname, diagnosis, verification) values (now(), 'medical_problem', 'Essential (primary) hypertension', '2015-02-01', 1, ?, 'admin', 'Default', 'ICD10:I10', 'confirmed')", [$pid]);
sqlInsert("insert into lists (date, type, title, begdate, activity, pid, user, groupname, diagnosis, verification) values (now(), 'medical_problem', 'Type 2 diabetes mellitus without complications', '2017-08-01', 1, ?, 'admin', 'Default', 'ICD10:E11.9', 'confirmed')", [$pid]);
sqlInsert("insert into prescriptions (patient_id, date_added, date_modified, provider_id, drug, rxnorm_drugcode, size, unit, route, `interval`, dosage, quantity, active, txDate, note, usage_category_title, request_intent_title) values (?, now(), now(), 1, 'Metformin 500 mg tablet', '860975', 500, 1, 1, 2, 'twice daily', '60', 1, curdate(), '', 'Community', 'Order')", [$pid]);
UuidRegistry::createMissingUuidsForTables(['lists', 'prescriptions', 'patient_data']);
echo "chart written for pid $pid\n";
